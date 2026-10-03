// Boot, the per-frame loop and the "world": which galaxy, which stars, which system is around the
// camera right now. Rendering is split into three camera-relative layers drawn back to front,
// each in its own unit so float32 never has to span more than it can:
//   cosmos (megaparsecs) -> galaxy (light years) -> system (kilometres, reversed-Z depth)
import * as THREE from 'three/webgpu'
import { texture } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { UPos, mulMat } from './upos.js'
import { LY, MPC, AU, OBSERVABLE_RADIUS, R_SUN } from './units.js'
import { view } from './sprites.js'
import { Cosmos, galaxyFromRecord } from './cosmos.js'
import { GalaxyCloud, galaxyRot, density } from './galaxy.js'
import { DeepSky } from './deepsky.js'
import { StarLevel, CLASSES, CatalogStars, starFromCell, starObject } from './stars.js'
import { System, genSystem, variantsSpec } from './system.js'
import { starOffsets } from './binary.js'
import { MILKY_WAY, REAL_STARS, solarSystemSpec, SGR_A } from './catalog.js'
import { Flight } from './flight.js'
import { Terrain } from './terrain.js'
import { UI } from './ui.js'

const J2000 = Date.UTC(2000, 0, 1, 12)
const SYSTEM_ENTER = 0.1 * LY, SYSTEM_LEAVE = 0.2 * LY

// ---- galaxies -----------------------------------------------------------------------------------
const MW = { ...MILKY_WAY, pos: MILKY_WAY.centerLy.map(v => v * LY) }
function center(g) { return g.center || (g.center = g.pos ? UPos.meters(...g.pos) : UPos.meters(...g.posMpc.map(v => v * MPC))) }
function rot(g) { return g.rot || (g.rot = galaxyRot(g)) }
function toLocal(g, p) {                                   // universe UPos -> galaxy frame, ly
  const d = p.sub(center(g)), r = rot(g)
  return [0, 1, 2].map(i => (r[i] * d[0] + r[3 + i] * d[1] + r[6 + i] * d[2]) / LY)
}
function toWorld(g, l) { return center(g).clone().addv(mulMat(rot(g), l), LY) }

// Sagittarius A* lives in the catalogue as a star-like object at the Milky Way's centre.
const CATALOG = [...REAL_STARS, { name: SGR_A.name, spec: 'SMBH', L: 0, T: 6000, R: SGR_A.radius / R_SUN, pos: MW.pos, seed: 4300000, blackhole: true }]

class World {
  async init() {
    const canvas = document.querySelector('#view')
    const renderer = this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false, reversedDepthBuffer: true })
    await renderer.init()
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1
    renderer.autoClear = false
    this.backend = renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2 fallback'

    this.layers = {
      cosmos: this.layer(1e-7, 1e6),
      galaxy: this.layer(1e-9, 1e9),
      system: this.layer(1e-4, 1e13),
    }
    this.rt = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
    const tex = texture(this.rt.texture)
    this.pipeline = new THREE.RenderPipeline(renderer)
    const glare = bloom(tex, 0.55, 0.35, 1.1)
    glare.smoothWidth.value = 2                            // soft knee: smooth skies cross the threshold without an edge
    this.pipeline.outputNode = tex.add(glare)

    this.cosmos = new Cosmos(this.layers.cosmos.scene)
    this.levels = CLASSES.map((_, k) => new StarLevel(k))
    for (const l of this.levels) this.layers.galaxy.scene.add(l.sprites.mesh)
    this.catalog = new CatalogStars(CATALOG)
    this.layers.galaxy.scene.add(this.catalog.sprites.mesh)
    this.deepsky = new DeepSky(this.layers.galaxy.scene)
    this.terrain = new Terrain(this.layers.system.scene, renderer)
    this.clouds = new Map()
    this.galaxy = null
    this.system = null
    this.selected = null
    this.time = { t: (Date.now() - J2000) / 1000, warp: 1, paused: false }
    this.showOrbits = true
    this.surf = 1e7

    this.flight = new Flight(canvas)
    this.ui = new UI(this)
    this.flight.onClick = (x, y) => this.ui.select(this.pick(x, y))
    this.flight.onDoubleClick = (x, y) => { const t = this.pick(x, y); if (t) { this.ui.select(t); this.goTo(t) } }
    this.flight.onArrive = t => { this.pendingNext?.(); this.pendingNext = null; if (t.kind !== 'place') this.ui.select(t) }
    addEventListener('resize', () => this.resize())
    this.resize()

    // start beside Earth, sunlit side, the Moon in the distance
    this.flight.pos = UPos.meters(0, 0, 0).add(0, 0, 3 * AU)
    this.environment(0)
    this.enterSystemNow()
    const earth = this.system.bodies.find(b => b.name === 'Earth')
    const tp = earth.p, sun = this.system.star.p.sub(tp), s = Math.hypot(...sun)
    const off = new THREE.Vector3(...sun).divideScalar(s).applyAxisAngle(new THREE.Vector3(0, 0, 1), 0.9).multiplyScalar(earth.radius * 3.4)
    this.flight.pos = tp.clone().add(off.x, off.y, off.z + earth.radius * 0.6)
    this.lookAt(tp)
    this.ui.select(this.bodyTarget(earth))

    // compile every layer's pipelines now, hidden objects included, so nothing compiles mid-flight later
    await Promise.all([this.layers.cosmos, this.layers.galaxy, this.layers.system].map(l => this.warm(l.scene, l)))
    // one planet of every generated variant, built now (~0.1 s) and compiled after boot by warmVariants()
    this.variants = new System(variantsSpec(solarSystemSpec()), this.flight.pos.clone(), this.layers.system.scene)
    this.variants.root.visible = false
    this.variants.advance(this.time.t)

    this.clock = new THREE.Clock()
    renderer.setAnimationLoop(() => this.frame())
    this.ready = true
    document.querySelector('#boot').classList.add('gone')
    this.warmVariants()
  }

  // In the background after boot: compile one planet of every generated variant, a group at a time so no frame gets
  // heavy, then keep them in the shader library (system.js). A later first visit to any system compiles nothing.
  async warmVariants() {
    await this.warmGroups(this.variants.root, this.layers.system)
    this.variants.dispose()
    this.variants = null
  }

  layer(near, far) {
    const cam = new THREE.PerspectiveCamera(55, 1, near, far)
    return { scene: new THREE.Scene(), cam }
  }

  resize() {
    const w = innerWidth, h = innerHeight, pr = this.renderer.getPixelRatio()
    if (!w || !h) return
    this.renderer.setSize(w, h)
    this.rt.setSize(Math.round(w * pr), Math.round(h * pr))
    for (const l of Object.values(this.layers)) { l.cam.aspect = w / h; l.cam.updateProjectionMatrix() }
    view.res.value.set(w * pr, h * pr)
    view.pxPerRad.value = (h * pr) / 2 / Math.tan((this.layers.system.cam.fov * Math.PI) / 360)
  }

  // Compile the render pipelines of `object` (as drawn into the HDR target, hidden parts too) without stalling a frame.
  // The first draw of a new material otherwise compiles its shaders on the spot: 0.2-8 s stalls on arriving at a system.
  warm(object, layer) {
    const shown = [], culled = []
    object.traverse(o => {
      if (!o.visible) { o.visible = true; shown.push(o) }
      if (o.frustumCulled) { o.frustumCulled = false; culled.push(o) }
    })
    const r = this.renderer, target = r.getRenderTarget()
    r.setRenderTarget(this.rt)
    const done = r.compileAsync(object, layer.cam, layer.scene)    // walks the objects before its first await
    r.setRenderTarget(target)
    for (const o of shown) o.visible = false
    for (const o of culled) o.frustumCulled = true
    return done.catch(e => console.warn('warm-up compile failed', e))
  }

  // warm() each child of root on its own frame: building a planet's shader graph is 5-30 ms of CPU even when its
  // pipeline is cached, so a whole system at once would stall one frame (~90 ms)
  async warmGroups(root, layer) {
    for (const o of [...root.children]) {
      await this.warm(o, layer)
      await new Promise(requestAnimationFrame)
    }
  }

  lookAt(p) {
    const d = p.sub(this.flight.pos)
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), new THREE.Vector3(...d).normalize(), new THREE.Vector3(0, 0, 1))
    this.flight.quat.setFromRotationMatrix(m)
  }

  // ---- per frame --------------------------------------------------------------------------------
  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1)
    if (!this.time.paused) this.time.t += dt * this.time.warp
    this.tickWaiting(dt)
    this.system?.advance(this.time.t)
    this.flight.update(dt, this, (this.layers.system.cam.fov * Math.PI) / 180)
    this.environment(dt)
    this.place()
    this.ui.update(dt)
    this.render()
  }

  // Work out what is around the camera: galaxies to draw as clouds, stars to stream, the system.
  environment() {
    const cam = this.flight.pos
    const camM = cam.meters(), camMpc = camM.map(v => v / MPC)
    this.cosmos.update(camMpc, this.flight.auto ? 3 : 6)

    // galaxies close enough to draw as particle clouds (impostors fade out over 8R..4R)
    const near = []
    this.cosmos.nearby(camMpc, 2.5, (g, dMpc) => { const d = dMpc * MPC / LY; if (d < g.R * 8) near.push([g, d]) })
    near.sort((a, b) => a[1] / a[0].R - b[1] / b[0].R)
    const keep = new Set()
    let built = false
    for (const [g0, d] of near.slice(0, 3)) {
      const g = g0.id === MW.id ? MW : g0
      keep.add(g.id)
      let c = this.clouds.get(g.id)
      if (!c && !built) {
        c = new GalaxyCloud(g); this.clouds.set(g.id, c); this.layers.galaxy.scene.add(c.group); built = true
        c.group.visible = false                                // shown once its pipelines are compiled
        this.warm(c.group, this.layers.galaxy).then(() => { c.group.visible = true })
      }
      if (c) c.fade = 1 - THREE.MathUtils.smoothstep(d, g.R * 4, g.R * 8)
    }
    for (const [id, c] of this.clouds) if (!keep.has(id)) { this.layers.galaxy.scene.remove(c.group); c.dispose(); this.clouds.delete(id) }

    // exposure: inside a galaxy its stars dominate; out in the dark the galaxies come up
    const nearestGal = near.reduce((m, [g1, d]) => Math.min(m, d / g1.R), Infinity)
    this.outside = THREE.MathUtils.smoothstep(nearestGal, 1.5, 6)

    // the galaxy we are inside streams its stars
    const inside = near.find(([g, d]) => d < g.R * 1.4)
    const g = inside ? (inside[0].id === MW.id ? MW : inside[0]) : null
    if (g !== this.galaxy) { this.galaxy = g; for (const l of this.levels) l.clear() }
    this.nearStars = []
    if (g) {
      const local = toLocal(g, cam)
      const rho = Math.max(density(g, ...local), 1e-3)
      const scale = 2 ** Math.round(Math.log2(Math.min(1, Math.max(0.06, rho ** (-1 / 3)))))
      let budget = 5
      for (const l of this.levels) { const t0 = performance.now(); l.update(g, local, budget, scale); budget = Math.max(0.5, budget - (performance.now() - t0)) }
      this.localLy = local
      this.scanStars(g, local)
    }

    // enter / leave star systems
    const nearest = this.nearStars[0]
    if (this.system && this.system.star.p.dist(cam) > SYSTEM_LEAVE) this.leaveSystem()
    if (!this.system && nearest && nearest.d * LY < SYSTEM_ENTER) this.enterSystem(nearest)

    // distance to the nearest surface drives flight speed
    let s = Infinity
    if (this.system) for (const b of this.system.bodies) s = Math.min(s, b.p.dist(cam) - (this.terrain.ground(this.system, b, cam) ?? b.radius))
    if (nearest) s = Math.min(s, nearest.d * LY - nearest.star.radius)
    // galaxies: follow the distance to where their stars actually are, never below the local
    // star spacing, so the rim is not a wall and the halo is crossed at galactic speed
    let gs = near.length ? Infinity : 1.5 * MPC
    for (const [g1] of near) gs = Math.min(gs, galaxyScale(g1.id === MW.id ? MW : g1, cam))
    s = Math.min(s, gs)
    const out = Math.hypot(...camM) - OBSERVABLE_RADIUS
    if (out > 0) s = Math.max(s, out)
    this.surf = s
  }

  // Stars within a few light years, nearest first. Each gets a stable key and world position.
  scanStars(g, local) {
    const list = []
    const R = 6
    for (const l of this.levels) {
      l.near(local, R, (cell, s, d2) => list.push({ d: Math.sqrt(d2), make: () => starFromCell(g, l, cell, s), key: 'p' + cell.seed[s], R: cell.R[s] * R_SUN }))
    }
    if (g.id === MW.id) {
      for (const s of CATALOG) {
        const l = [s.pos[0] / LY - MW.centerLy[0], s.pos[1] / LY - MW.centerLy[1], s.pos[2] / LY - MW.centerLy[2]]
        const d = Math.hypot(l[0] - local[0], l[1] - local[1], l[2] - local[2])
        if (d < R) list.push({ d, make: () => ({ ...starObject(MW, s), kind: s.blackhole ? 'blackhole' : 'star' }), key: 'real:' + s.name, R: s.R * R_SUN })
      }
    }
    list.sort((a, b) => a.d - b.d)
    for (const x of list) x.star = { radius: x.R }
    this.nearStars = list
  }

  starPos(s) { return s.helio ? UPos.meters(...s.helio) : toWorld(s.galaxy, s.local) }

  enterSystem(n) {
    const star = n.make()
    const origin = this.starPos(star)
    let spec
    if (star.name === 'Sun') spec = solarSystemSpec()
    else if (star.kind === 'blackhole') spec = { star: { ...star, kind: 'blackhole' }, planets: [], moons: [], frame: [1, 0, 0, 0, 1, 0, 0, 0, 1], mass: 4.3e6 }
    else spec = genSystem(star)                       // companions, if any, are part of the spec
    const sys = this.system = new System(spec, origin, this.layers.system.scene)
    sys.root.visible = false                                 // shown once its pipelines are compiled
    this.warmGroups(sys.root, this.layers.system).then(() => { sys.root.visible = true })
    this.system.key = n.key
    this.system.starInfo = star
    this.system.advance(this.time.t)
    this.ui.onSystem(this.system)
  }
  enterSystemNow() { this.environment(0); const n = this.nearStars[0]; if (!this.system && n) this.enterSystem(n) }

  leaveSystem() {
    if (this.flight.frame) { this.flight.frame = null }
    this.system.dispose()
    this.system = null
    this.ui.onSystem(null)
  }

  // ---- flight hooks ---------------------------------------------------------------------------
  surfaceDistance() { return this.surf }
  corotate(f) { if (this.system) this.terrain.corotate(f, this.system) }
  pickFrame(pos) {
    if (!this.system || this.flight.auto) return null
    let best = null, bestR = Infinity
    for (const b of this.system.bodies) {
      if (!b.orbit && !b.binary) continue                    // stars in a multiple system move too
      const r = b.p.dist(pos) / b.radius
      if (r < (b.type === 'moon' ? 250 : b.orbit ? 500 : 60) && r < bestR) { best = b; bestR = r }
    }
    return best
  }
  collide(f) {
    if (!this.system) return
    for (const b of this.system.bodies) {
      const g = this.terrain.ground(this.system, b, f.pos)           // landable: the terrain under the camera
      const d = f.pos.sub(b.p), r = Math.hypot(...d), min = g === null ? b.radius * 1.0004 + 30 : g + this.terrain.clearance()
      if (r < min) f.pos.copy(b.p).add(d[0] / r * min, d[1] / r * min, d[2] / r * min)
    }
  }

  // ---- targets: anything selectable becomes { kind, name, getPos, radius, standoff, arrival } ----
  bodyTarget(b) {
    const sys = this.system
    return {
      kind: b.type, name: b.name, body: b, radius: b.radius, getPos: () => b.p,
      standoff: b.radius * (b.type === 'star' ? 6 : b.type === 'blackhole' ? 40 : b.rings ? 5 : 3.2),
      arrival: u => {                                       // swing round toward the day side
        if (b.type === 'star' || b.type === 'blackhole') return u
        const s = sys.star.p.sub(b.p), l = Math.hypot(...s)
        return u.add(new THREE.Vector3(...s).divideScalar(l).multiplyScalar(1.3)).normalize()
      },
    }
  }
  starTarget(s) {
    const pos = this.starPos(s)
    const bh = s.kind === 'blackhole'
    return { kind: bh ? 'blackhole' : 'star', name: s.name, star: s, radius: s.radius, standoff: bh ? s.radius * 40 : Math.max(s.radius * 25, 1.2 * AU * Math.sqrt(Math.max(s.L, 0.01)) ** 0.8, this.span(s)),
      getPos: () => (this.system?.starInfo?.id === s.id ? this.system.star.p : pos),    // once inside, the primary itself
      arrival: u => this.pairArrival(s, u) }
  }
  // come in on the far side of the primary from its outermost companion, so both are in view
  pairArrival(s, u) {
    const g = this.sysSpec(s), outer = g.pairs?.at(-1)
    if (!outer) return u
    const off = starOffsets(g.stars.map(m => m.mass), g.pairs, this.time.t), c = off[(outer.ga.includes(0) ? outer.gb : outer.ga)[0]]
    const n = new THREE.Vector3(off[0][0] - c[0], off[0][1] - c[1], off[0][2] - c[2]).normalize()
    const side = u.clone().addScaledVector(n, -u.dot(n)).normalize()
    return n.multiplyScalar(Math.cos(0.5)).addScaledVector(side, Math.sin(0.5)).normalize()
  }
  // stand back far enough to see all of a multiple system's stars (capped for wide pairs)
  span(s) { return Math.min(150 * AU, 1.2 * Math.max(0, ...(this.sysSpec(s).pairs ?? []).map(p => p.a))) }
  galaxyTarget(g0) {
    const g = g0.id === MW.id ? MW : g0
    const c = center(g), n = new THREE.Vector3(...(g.normal || [0, 0, 1]))
    return {
      kind: 'galaxy', name: g.name, galaxy: g, radius: g.R * LY, dollyR: 0, getPos: () => c, standoff: g.R * LY * 2.6,
      arrival: u => { const s = Math.sign(u.dot(n)) || 1; return u.clone().multiplyScalar(0.6).add(n.clone().multiplyScalar(s)).normalize() },
    }
  }
  placeTarget(name, pos, standoff, radius = 0) { return { kind: 'place', name, radius, dollyR: 0, getPos: () => pos, standoff } }
  // nebulae and clusters: arrive on the Earth-facing side, so they look the way the photographs do
  dsoTarget(o) {
    return { kind: 'deepsky', name: o.name, dso: o, radius: o.radius * LY, dollyR: 0, getPos: () => o.upos, standoff: o.radius * LY * 2.6, arrival: () => new THREE.Vector3(...o.sunward) }
  }

  goTo(t, then) {
    if (!t) return
    this.pendingNext = then || null
    this.flight.goTo(t, t.standoff)
  }

  // ---- placing layers relative to the camera ------------------------------------------------------
  place() {
    const cam = this.flight.pos, q = this.flight.quat
    for (const l of Object.values(this.layers)) l.cam.quaternion.copy(q)
    const camMpc = cam.meters().map(v => v / MPC)
    this.cosmos.place(camMpc)
    this.cosmos.setExposure(this.outside ?? 1)
    const rel = [0, 0, 0]
    for (const [id, c] of this.clouds) {
      const g = id === MW.id ? MW : c.g
      center(g).sub(cam, rel)
      c.group.position.set(rel[0] / LY, rel[1] / LY, rel[2] / LY)
      c.opacity = c.fade ?? 0
      c.gain = 0.12 + 0.88 * THREE.MathUtils.smoothstep(Math.hypot(...rel) / LY / g.R, 0.8, 2.2)
    }
    const g = this.galaxy
    for (const l of this.levels) {
      l.sprites.mesh.visible = !!(g && l.anchor && l.gid === g.id)
      if (!l.sprites.mesh.visible) continue
      toWorld(g, l.anchor).sub(cam, rel)
      l.sprites.mesh.position.set(rel[0] / LY, rel[1] / LY, rel[2] / LY)
      l.sprites.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().set(...rot(g).slice(0, 3), 0, ...rot(g).slice(3, 6), 0, ...rot(g).slice(6, 9), 0, 0, 0, 0, 1))
    }
    this.catalog.sprites.mesh.visible = Math.hypot(...cam.meters()) < 3e5 * LY
    new UPos().sub(cam, rel)
    this.catalog.sprites.mesh.position.set(rel[0] / LY, rel[1] / LY, rel[2] / LY)
    this.deepsky.place(cam)
    this.system?.place(cam, this.showOrbits, this.flight.frame)
    const sc = this.layers.system.cam
    this.terrain.update(this.system, cam, sc, (sc.fov * Math.PI) / 180 / (innerHeight * this.renderer.getPixelRatio()))
  }

  render() {
    if (!innerWidth || !innerHeight) return             // hidden or collapsed pane: nothing to draw into
    if (this.rt.width !== Math.round(innerWidth * this.renderer.getPixelRatio())) this.resize()
    const r = this.renderer
    r.setRenderTarget(this.rt)
    r.setClearColor(0x000000, 1)
    r.clear()
    const { cosmos, galaxy, system } = this.layers
    r.render(cosmos.scene, cosmos.cam)
    r.clearDepth()
    r.render(galaxy.scene, galaxy.cam)
    r.clearDepth()
    r.render(system.scene, system.cam)
    r.setRenderTarget(null)
    this.pipeline.render()
  }

  // ---- picking: nearest bright thing to the cursor ------------------------------------------------
  project(rel) {                                          // metres, camera-relative -> px
    const v = new THREE.Vector3(...rel).applyQuaternion(this.flight.quat.clone().invert())
    if (v.z >= 0) return null
    const f = view.pxPerRad.value / this.renderer.getPixelRatio()
    return [innerWidth / 2 + (v.x / -v.z) * f, innerHeight / 2 - (v.y / -v.z) * f, -v.z]
  }

  pick(x, y) {
    let best = null, bestScore = 0
    const cam = this.flight.pos, rel = [0, 0, 0]
    const consider = (make, relM, radius, brightness) => {
      const p = this.project(relM)
      if (!p) return
      const pxR = (radius / p[2]) * view.pxPerRad.value / this.renderer.getPixelRatio()
      const dd = Math.hypot(p[0] - x, p[1] - y)
      if (dd > Math.max(pxR, 0) + 12) return
      const score = (brightness + (pxR > 2 ? 100 * pxR : 0)) / (1 + dd * dd * 0.05)
      if (score > bestScore) { bestScore = score; best = make }
    }
    if (this.system) for (const b of this.system.bodies) consider(() => this.bodyTarget(b), b.p.sub(cam, [0, 0, 0]), b.radius, 1e3)
    const g = this.galaxy
    if (g) {
      for (const l of this.levels) for (const [, cell] of l.cells) for (let s = 0; s < cell.n; s++) {
        const lp = [cell.pos[s * 3], cell.pos[s * 3 + 1], cell.pos[s * 3 + 2]]
        const d = [lp[0] - this.localLy[0], lp[1] - this.localLy[1], lp[2] - this.localLy[2]]
        const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
        const I = (100 * cell.lum[s]) / Math.max(d2, 1e-12)
        if (I < 0.02 || d2 > (l.reach * 1.1) ** 2) continue
        consider(() => this.starTarget(starFromCell(g, l, cell, s)), mulMat(rot(g), d).map(v => v * LY), 0, I)
      }
    }
    for (const s of CATALOG) {
      new UPos().add(...s.pos).sub(cam, rel)
      const d = Math.hypot(...rel) / LY
      const I = s.blackhole ? 5 : (100 * s.L) / Math.max(d * d, 1e-12)
      if (I > 0.02) consider(() => this.starTarget({ ...starObject(MW, s), kind: s.blackhole ? 'blackhole' : 'star' }), [...rel], 0, I * 3)
    }
    const camMpc = cam.meters().map(v => v / MPC)
    const galaxies = (g0, gp) => {
      const d = [(gp[0] - camMpc[0]) * MPC, (gp[1] - camMpc[1]) * MPC, (gp[2] - camMpc[2]) * MPC]
      const dist = Math.hypot(...d)
      if (dist < g0.R * LY * 1.5) return
      // only galaxies you can actually see at the current exposure are clickable
      const seen = 0.5 * (g0.lum ?? 1) * Math.min(1, (g0.R * LY / dist) * 3000) * (g0.real ? 0.3 + 0.7 * this.outside : this.outside)
      if (seen > 0.02) consider(() => this.galaxyTarget(g0), d, g0.R * LY, seen)
    }
    for (const g0 of this.cosmos.namedList) galaxies(g0, g0.pos.map(v => v / MPC))
    if (this.outside > 0.05) for (const cell of this.cosmos.cells.values()) for (const rec of cell.list) if (rec.g) galaxies(rec.g, rec.g.posMpc)
    // nebulae and clusters: a click anywhere on the patch, unless you are already inside it
    if (this.deepsky.root.visible) for (const o of this.deepsky.list) {
      const p = this.project(o.upos.sub(cam, rel))
      const pxR = p && (o.radius * LY / p[2]) * view.pxPerRad.value / this.renderer.getPixelRatio()
      if (!p || pxR > innerHeight * 0.6) continue
      const dd = Math.hypot(p[0] - x, p[1] - y), score = 40 / (1 + (dd * dd) / (pxR * pxR + 100))
      if (dd < pxR + 12 && score > bestScore) { bestScore = score; best = () => this.dsoTarget(o) }
    }
    return best ? best() : null
  }

  // ---- named destinations -------------------------------------------------------------------------
  find(name) {
    const lc = name.toLowerCase()
    if (this.system) { const b = this.system.bodies.find(b => b.name.toLowerCase() === lc); if (b) return { target: this.bodyTarget(b) } }
    const sol = solarSystemSpec()
    if ([...sol.planets, ...sol.moons].some(p => p.name.toLowerCase() === lc)) {
      const sun = CATALOG[0]
      return { target: this.starTarget(starObject(MW, sun)), then: () => { const b = this.system?.bodies.find(b => b.name.toLowerCase() === lc); if (b) this.goTo(this.bodyTarget(b)) } }
    }
    const s = CATALOG.find(s => s.name.toLowerCase() === lc)
    if (s) return { target: this.starTarget({ ...starObject(MW, s), kind: s.blackhole ? 'blackhole' : 'star' }) }
    const host = CATALOG.find(s => s.multiple?.stars.some(m => m[0].toLowerCase() === lc))   // e.g. Sirius B: fly to the system, then to it
    if (host) return { target: this.starTarget(starObject(MW, host)), then: () => { const b = this.system?.bodies.find(b => b.name.toLowerCase() === lc); if (b) this.goTo(this.bodyTarget(b)) } }
    const g = this.cosmos.namedList.find(g => g.name.toLowerCase() === lc)
    if (g) return { target: this.galaxyTarget(g) }
    const o = this.deepsky.find(name)
    if (o) return { target: this.dsoTarget(o) }
    return null
  }
  // ---- any star system --------------------------------------------------------------------------
  planetCount(s) {
    if (s.name === 'Sun') return 9
    if (s.kind === 'blackhole') return 0
    return (s.planetCount ??= genSystem(s).planets.length)
  }
  // generated system spec for a star object, cached on it
  sysSpec(s) {
    if (s.name === 'Sun' || s.kind === 'blackhole') return { planets: [] }
    return (s.gen ??= genSystem(s))
  }
  companions(s) { return (this.sysSpec(s).stars ?? []).slice(1) }

  // Streamed stars within r ly, nearest first, as star objects with their planet counts.
  systemsNear(r = 60, limit = 16) {
    const g = this.galaxy, p = this.localLy
    if (!g || !p) return []
    const all = []
    for (const l of this.levels) for (const cell of l.cells.values()) for (let s = 0; s < cell.n; s++) {
      const dx = cell.pos[s * 3] - p[0], dy = cell.pos[s * 3 + 1] - p[1], dz = cell.pos[s * 3 + 2] - p[2]
      const d = Math.hypot(dx, dy, dz)
      if (d < r) all.push({ d, make: () => starFromCell(g, l, cell, s) })
    }
    if (g.id === MW.id) for (const s of CATALOG) {
      const d = Math.hypot(s.pos[0] / LY - MW.centerLy[0] - p[0], s.pos[1] / LY - MW.centerLy[1] - p[1], s.pos[2] / LY - MW.centerLy[2] - p[2])
      if (d < r) all.push({ d, make: () => ({ ...starObject(MW, s), kind: s.blackhole ? 'blackhole' : 'star' }) })
    }
    all.sort((a, b) => a.d - b.d)
    return all.slice(0, limit).map(e => { const star = e.make(); return { d: e.d, star, planets: this.planetCount(star) } })
  }

  goToStar(star, select = true) {
    const t = this.starTarget(star)
    if (select) this.ui.select(t)
    this.goTo(t)
  }

  // Random system: 'near' (a few dozen ly), 'galaxy' (anywhere in this galaxy), 'far' (inside another galaxy).
  wander(scope) {
    if (scope === 'near') {
      const pool = this.systemsNear(90, 200).filter(e => e.planets > 0 && e.d > 0.2)
      if (pool.length) this.goToStar(pool[Math.floor(Math.random() * pool.length)].star)
      return
    }
    let g = this.galaxy || MW
    if (scope === 'far') {
      const pool = [...this.cosmos.namedList.filter(x => x.id !== g.id)]
      for (const cell of this.cosmos.cells.values()) for (const rec of cell.list) if (rec.L > 0.5 && pool.length < 400) pool.push(rec.g || (rec.g = galaxyFromRecord(rec)))
      g = pool[Math.floor(Math.random() * pool.length)]
      if (g.id === MW.id) g = MW
    }
    const pos = toWorld(g, randomPointIn(g))
    this.ui.select(null)
    this.goTo(this.placeTarget(`somewhere in ${g.name}`, pos, 0.3 * LY), () => this.afterStreaming(() => this.goToNearestSystem()))
  }

  // Run cb once the stars around the camera have streamed in.
  afterStreaming(cb) { this.waiting = { cb, t: 0 } }
  tickWaiting(dt) {
    const w = this.waiting
    if (!w) return
    w.t += dt
    if ((w.t > 0.4 && this.galaxy && this.levels.every(l => !l.pending)) || w.t > 6) { this.waiting = null; w.cb() }
  }
  goToNearestSystem() {
    const list = this.systemsNear(400, 60)
    const pick = list.find(e => e.planets > 0) || list[0]
    if (pick) this.goToStar(pick.star)
  }

  travel(name) {
    if (name === 'Cosmic web') return this.goTo(this.placeTarget('the cosmic web', UPos.meters(0, 0, 0), 300 * MPC))
    if (name === 'Observable universe') return this.goTo(this.placeTarget('the observable universe', UPos.meters(0, 0, 0), OBSERVABLE_RADIUS * 2.6))
    const f = this.find(name)
    if (f) this.goTo(f.target, f.then)
  }
}

// Travel scale (m) around a galaxy: half the distance to its disk (or an elliptical's core),
// floored at the local spacing between stars.
function galaxyScale(g, cam) {
  const [x, y, z] = toLocal(g, cam)
  const spacing = Math.max(0.5, 0.6 * (0.004 * Math.max(density(g, x, y, z), 1e-4)) ** (-1 / 3))
  const slab = g.type === 'elliptical' ? Math.max(Math.hypot(x, y, z) - g.R * 0.25, 0)
    : Math.hypot(Math.max(Math.abs(z) - g.hz * 2, 0), Math.max(Math.hypot(x, y) - g.R, 0))
  return Math.max(spacing, 0.5 * slab) * LY
}

// A random point drawn from a galaxy's own light distribution (galaxy frame, ly).
function randomPointIn(g) {
  const lap = () => (Math.random() < 0.5 ? -1 : 1) * -Math.log(1 - Math.random())
  if (g.type === 'elliptical') return [0, 1, 2].map(() => (Math.random() + Math.random() + Math.random() - 1.5) * g.R * 0.25)
  const r = Math.min(g.hR * -Math.log((1 - Math.random()) * (1 - Math.random())) * 0.8, g.R), th = Math.random() * Math.PI * 2
  return [r * Math.cos(th), r * Math.sin(th), lap() * g.hz * 0.4]
}

const world = new World()
window.uni = world
// console helpers: look along a universe-axis direction, jump somewhere in light years from the Sun
world.lookDir = (x, y, z) => world.lookAt(world.flight.pos.clone().add(x * 1e30, y * 1e30, z * 1e30))
world.jumpLy = (x, y, z) => { world.flight.frame = null; world.flight.pos = UPos.meters(x * LY, y * LY, z * LY) }
world.init().catch(e => {
  console.error(e)
  document.querySelector('#boot').innerHTML = `<p>This needs a browser with WebGPU (recent Chrome or Edge).</p><pre>${e.message}</pre>`
})
