// Planetary systems: Keplerian orbits, the real Solar System and generated ones. A System builds
// its meshes into the system layer (units km) and places them relative to the camera each frame.
import * as THREE from 'three/webgpu'
import { uniform } from 'three/tsl'
import { Rng } from './rng.js'
import { UPos, mulMat, matMul, rotX, rotZ, randomRot } from './upos.js'
import { AU, KM, G, R_EARTH, R_SUN, LY } from './units.js'
import { LOOKS, proceduralLook } from './looks.js'
import { planetMaterial, ringMaterial, starMaterial, diskMaterial, orbitMaterial } from './materials.js'
import { atmosphere } from './atmosphere.js'
import { starSprites, upload, tempColor } from './sprites.js'
import { multiple, planetZone, buildStars, hostOf, moveStars, starLight, placeStarOrbits, GM_SUN } from './binary.js'

const SPHERE = new THREE.SphereGeometry(1, 160, 80)
const LOW_SPHERE = new THREE.SphereGeometry(1, 64, 32)

// Position on a Kepler orbit at time t (s since J2000), in the orbit's reference plane (metres).
export function kepler(o, t, out = [0, 0, 0]) {
  const M = o.M0 + o.n * t
  let E = M
  for (let k = 0; k < 8; k++) E -= (E - o.e * Math.sin(E) - M) / (1 - o.e * Math.cos(E))
  const x = o.a * (Math.cos(E) - o.e), y = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E)
  return mulMat(o.plane, [x, y, 0], out)
}
const orbitPlane = (node, i, peri) => matMul(rotZ(node), matMul(rotX(i), rotZ(peri)))

// ---- generation -------------------------------------------------------------------------------
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
export function genSystem(star) {
  const rng = new Rng(star.seed ^ 0x9e3779b9)
  const L = star.L
  const giant = /III|I$|Ia|Iab|Ib|LBV/.test(star.spec)
  const dwarf = star.spec === 'D'
  const brown = star.spec === 'L' || star.spec === 'T'
  const count = dwarf ? rng.int(0, 2) : brown ? rng.int(0, 3) : giant ? rng.int(0, 4) : star.T < 3700 ? rng.int(1, 7) : star.T > 10000 ? rng.int(0, 5) : rng.int(2, 9)
  const planets = [], moons = []
  const mass = star.mass ?? massOf(star), mult = multiple(star, mass)
  let a = AU * 0.22 * Math.max(L, 0.001) ** 0.3 * rng.range(0.5, 1.4)
  a = Math.max(a, star.radius * 4)
  // companions bound the planets (S-type) or push them out around a pair (P-type, circumbinary)
  const zone = planetZone(mult, a), circum = zone.host.pair != null
  const Lh = mult ? zone.members.reduce((s, k) => s + mult.stars[k].L, 0) : L
  const hostName = circum ? mult.pairs[zone.host.pair].name : mult ? mult.stars[0].name : star.name
  a = Math.max(a, zone.lo)
  for (let p = 0; p < (circum ? Math.min(count, 5) : count) && a < zone.hi; p++) {
    const aAU = a / AU
    const T = 278 * Lh ** 0.25 / Math.sqrt(aAU)
    const kind = planetKind(rng, T, p)
    const size = rng.range(...SIZES[kind])
    const name = `${hostName} ${String.fromCharCode(98 + p)}`
    planets.push({
      name, host: zone.host, kind, look: proceduralLook(kind, rng), radius: size * R_EARTH, a, e: 0.12 * rng.next() ** 2, i: rng.gauss() * 0.03,
      node: rng.range(0, 6.28), peri: rng.range(0, 6.28), M0: rng.range(0, 6.28), rotation: rng.range(8, 60) * 3600 * (rng.next() < 0.1 ? -1 : 1),
      tilt: Math.abs(rng.gauss()) * 0.4, rings: ((kind === 'gas' && rng.next() < 0.45) || (kind === 'subneptune' && rng.next() < 0.12)) || (kind === 'icegiant' && rng.next() < 0.3) ? [size * R_EARTH * rng.range(1.3, 1.6), size * R_EARTH * rng.range(2.0, 2.6)] : null,
      teq: T,
    })
    const nm = kind === 'gas' ? rng.int(1, 5) : kind === 'icegiant' || kind === 'subneptune' ? rng.int(0, 3) : kind === 'hotjupiter' ? 0 : rng.next() < 0.3 ? rng.int(1, 2) : 0
    let ma = size * R_EARTH * rng.range(3.5, 6)
    for (let m = 0; m < nm; m++) {
      const big = kind === 'gas' || kind === 'hotjupiter' ? 0.45 : 0.27
      const mr = rng.range(0.05, big)
      const mk = pickW(rng, [['rock', 3], ['iceworld', T < 300 ? 4 : 0], ['frozen', T < 250 ? 2 : 0], ['volcanic', big > 0.3 ? 1.2 : 0], ['hazy', mr > 0.3 ? 1 : 0], ['lava', T > 500 ? 2 : 0]])
      moons.push({ parent: name, name: `${name} ${ROMAN[m]}`, kind: mk, look: proceduralLook(mk, rng), radius: R_EARTH * mr, locked: true, a: ma, e: 0.02 * rng.next(), i: rng.gauss() * 0.02, node: rng.range(0, 6.28), peri: 0, M0: rng.range(0, 6.28), tilt: 0 })
      ma *= rng.range(1.5, 2.4)
    }
    a *= rng.range(1.45, 2.3)
  }
  const frame = randomRot(rng), around = circum && mult.pairs[zone.host.pair]
  for (const p of mult?.pairs ?? []) if (!p.real) p.plane = matMul(frame, p.plane)
  return { star: { ...star }, stars: mult?.stars, pairs: mult?.pairs, name: mult?.name ?? star.name, planets, moons, mass, frame: around?.real ? around.plane : frame }
}
function massOf(star) {
  if (star.spec === 'D') return 0.6
  if (star.spec === 'L' || star.spec === 'T') return 0.05
  if (/III|I$|Ia|Iab|Ib/.test(star.spec)) return 1.5 + star.L ** 0.2
  return Math.max(0.08, star.L < 0.033 ? (star.L / 0.23) ** (1 / 2.3) : star.L ** 0.25)   // red dwarfs follow L ~ 0.23 M^2.3
}
const DENSITY = { gas: 1300, icegiant: 1600, hotjupiter: 700, subneptune: 2200 }

// Planet radii (Earth radii) per kind
const SIZES = {
  lava: [0.4, 1.6], rock: [0.3, 1.5], desert: [0.5, 1.6], venus: [0.7, 1.4], ocean: [0.8, 1.5], waterworld: [1, 2],
  arid: [0.6, 1.4], marslike: [0.35, 0.8], tundra: [0.6, 1.3], frozen: [0.3, 1.2], iceworld: [0.2, 0.8],
  subneptune: [2, 3.6], gas: [7, 13], hotjupiter: [10, 16], icegiant: [3.4, 4.6],
}
function pickW(rng, table) {
  let r = rng.next() * table.reduce((s, [, w]) => s + w, 0)
  for (const [k, w] of table) if ((r -= w) < 0) return k
  return table[0][0]
}
// What kind of world forms at equilibrium temperature T (K); p = index from the star.
function planetKind(rng, T, p) {
  if (T > 1100) return pickW(rng, [['lava', 4], ['rock', 3], ['hotjupiter', p === 0 ? 1.5 : 0.3]])
  if (T > 400) return pickW(rng, [['venus', 3], ['desert', 2], ['rock', 2], ['subneptune', 2], ['hotjupiter', p === 0 ? 0.6 : 0]])
  if (T > 250) return pickW(rng, [['ocean', 2.5], ['waterworld', 1.2], ['arid', 2], ['desert', 1], ['venus', 1], ['subneptune', 2], ['rock', 1]])
  if (T > 170) return pickW(rng, [['marslike', 3], ['tundra', 2], ['frozen', 1.5], ['rock', 1.5], ['subneptune', 1.5]])
  if (T > 60) return pickW(rng, [['gas', 6], ['subneptune', 1.5], ['frozen', 1.5], ['iceworld', 1.5]])
  return pickW(rng, [['icegiant', 5], ['iceworld', 3], ['frozen', 1.5]])
}
const massFromRadius = b => 4 / 3 * Math.PI * b.radius ** 3 * (DENSITY[b.kind] ?? 5000)

// ---- shader library ----------------------------------------------------------------------------
// A body's shader code depends only on its look's features (materials.js keeps the numbers in uniforms). On leaving a
// system, the first object of each variant not seen before is kept, hidden and never disposed, so three keeps its
// compiled pipeline and the next planet of that variant draws at once instead of compiling for seconds.
const FEATURES = ['haze', 'spot', 'craters', 'cap', 'cracks', 'clouds', 'lava', 'glow']
const kept = new Set()
const variantOf = (look, rings) => look.maps ? `mapped ${Object.keys(LOOKS).find(k => LOOKS[k] === look)}`
  : [look.mode === 1 ? 'banded' : 'rocky', look.sea > 0 && 'sea', ...FEATURES.filter(f => look[f]), look.atmo && 'air', rings && (look.ringMaps ? 'mapped rings' : 'rings')]
    .filter(Boolean).join(' ')

// A system with one planet of every variant generated worlds can have (sampled), big and small, with and without
// rings: World builds it at boot, compiles it and disposes it into the library, so first visits compile nothing.
export function variantsSpec(base) {
  const rng = new Rng(12345), seen = new Set(), planets = []
  for (const kind of [...Object.keys(SIZES), 'volcanic', 'hazy']) for (let n = 0; n < 24; n++) {
    const look = proceduralLook(kind, rng)
    for (const radius of [R_EARTH, 0.2 * R_EARTH]) for (const rings of /gas|icegiant|subneptune/.test(kind) ? [null, [2 * radius, 3 * radius]] : [null]) {
      const v = variantOf(look, rings) + (radius > 2e6 ? '' : ' small')
      if (seen.has(v) || kept.has(v)) continue
      seen.add(v)
      planets.push({ ...base.planets[2], name: `variant ${planets.length}`, kind, look, radius, rings })
    }
  }
  return { ...base, planets, moons: [] }
}

// ---- runtime -----------------------------------------------------------------------------------
export class System {
  // spec: from genSystem / solarSystemSpec; origin: UPos of the system's barycentre
  constructor(spec, origin, scene) {
    this.spec = spec
    this.scene = scene
    this.root = new THREE.Group()
    scene.add(this.root)
    this.bodies = []
    const F = spec.frame
    this.star = buildStars(this, spec, origin)               // all stars; the primary is this.star
    this.name = spec.name ?? spec.star.name
    const byName = new Map()
    for (const p of spec.planets) {
      const host = hostOf(this, p.host)                        // a star, or a pair's barycentre
      const orbit = { a: p.a, e: p.e, M0: p.M0, n: Math.sqrt(host.msun * GM_SUN / p.a ** 3), plane: matMul(F, orbitPlane(p.node, p.i, p.peri)) }
      const equator = matMul(F, matMul(rotZ(p.node), matMul(rotX(p.i), rotX(-p.tilt))))
      const b = this.addBody({ ...p, kind: p.kind ?? 'planet', type: 'planet', parent: host, orbit, equator })
      b.mass = massFromRadius(p)
      byName.set(p.name, b)
    }
    for (const m of spec.moons) {
      const parent = byName.get(m.parent)
      if (!parent) continue
      const n = m.period ? (2 * Math.PI / m.period) * (m.retro ? -1 : 1) : Math.sqrt(G * parent.mass / m.a ** 3)
      const ref = m.eclipticPlane ? F : parent.equator
      const orbit = { a: m.a, e: m.e, M0: m.M0, n, plane: matMul(ref, orbitPlane(m.node, m.i, m.peri)) }
      this.addBody({ ...m, type: 'moon', parent, orbit, equator: orbit.plane, rotation: m.rotation ?? 2 * Math.PI / Math.abs(n) })
    }
  }

  addStar(s, upos, primary) {
    const rgb = tempColor(s.T)
    const group = new THREE.Group()
    const bh = s.kind === 'blackhole'
    const { mat, u } = bh ? { mat: new THREE.MeshBasicNodeMaterial({ color: 0x000000 }), u: null } : starMaterial(rgb)
    const mesh = new THREE.Mesh(SPHERE, mat)
    group.add(mesh)
    if (bh) {
      const disk = new THREE.Mesh(new THREE.RingGeometry(3, 14, 256, 1), diskMaterial(3, 14))
      disk.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(-0.75, 0.35, 0.56).normalize())   // tilted toward the Sun
      group.add(disk)
    }
    // the glow as a point source in km: flux = L / d_ly^2 with d in km -> scale by (ly/km)^2
    const glow = starSprites(1, { gain: 100, lumScale: (LY / KM) ** 2, fadeFar: 0.032 * LY / KM })
    glow.mesh.material.depthTest = true                    // planets and terrain hide the glow (sunset, night side)
    upload(glow.geometry, { iPos: new Float32Array(3), iColor: new Float32Array(rgb), iLum: new Float32Array([bh ? 0 : s.L]) }, 1)
    group.add(glow.mesh)
    group.userData.variant = bh ? 'blackhole' : 'star'
    this.root.add(group)
    const body = { ...s, type: bh ? 'blackhole' : 'star', kind: bh ? 'blackhole' : 'star', radius: s.radius ?? s.R * R_SUN, p: upos.clone(), group, mesh, glow, primary, starU: u }
    mesh.scale.setScalar(body.radius / KM)
    group.children.slice(1, bh ? 2 : 1).forEach(o => o.scale.setScalar(body.radius / KM))
    this.bodies.push(body)
    return body
  }

  addBody(b) {
    const look = typeof b.look === 'string' ? LOOKS[b.look] : b.look
    const seed = [...b.name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
    const group = new THREE.Group()
    const { mat, u } = planetMaterial(look, seed)
    const mesh = new THREE.Mesh(b.radius > 2e6 ? SPHERE : LOW_SPHERE, mat)
    mesh.scale.setScalar(b.radius / KM)
    group.add(mesh)
    const center = uniform(new THREE.Vector3())
    const body = { ...b, look, p: new UPos(), group, mesh, u, center, extras: [] }
    if (look.atmo) {                                       // sky shell + aerial perspective on the ground
      body.air = atmosphere(body, this.star)
      mat.colorNode = body.air.surface(mat.colorNode)
      group.add(body.air.mesh)
    }
    if (b.rings) {
      const [ri, ro] = b.rings.map(v => v / KM)
      const r = ringMaterial(ri, ro, seed % 13, center, b.radius / KM, look.ringMaps)
      const ring = new THREE.Mesh(new THREE.RingGeometry(ri, ro, 256, 4), r.mat)
      ring.quaternion.setFromRotationMatrix(mat4(b.equator))
      group.add(ring); body.extras.push(r.u)
    }
    body.orbitLine = this.orbitLine(b.orbit, b.type === 'moon')
    group.userData.variant = variantOf(look, b.rings) + (b.radius > 2e6 ? '' : ' small')   // SPHERE or LOW_SPHERE
    this.root.add(group)
    this.bodies.push(body)
    return body
  }

  orbitLine(o, moon) {
    const N = 512, pts = new Float32Array((N + 1) * 3), tmp = [0, 0, 0]
    for (let k = 0; k <= N; k++) {
      const E = (k / N) * Math.PI * 2
      mulMat(o.plane, [o.a * (Math.cos(E) - o.e), o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E), 0], tmp)
      pts[k * 3] = tmp[0] / KM; pts[k * 3 + 1] = tmp[1] / KM; pts[k * 3 + 2] = tmp[2] / KM
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    const line = new THREE.Line(g, orbitMaterial(moon ? 0x7d8aa0 : 0x8fa6d8, moon ? 0.12 : 0.3))
    line.frustumCulled = false
    line.userData.variant = 'orbit'
    this.root.add(line)
    return line
  }

  // Advance orbits to time t (parents come before children in this.bodies).
  advance(t) {
    this.t = t
    const tmp = [0, 0, 0]
    moveStars(this, t)
    for (const b of this.bodies) if (b.orbit) b.p.copy(b.parent.p).addv(kepler(b.orbit, t, tmp))
  }

  // A body's orientation at the current time (terrain.js needs it before place() runs).
  // Spin about the axis; local Y of the sphere geometry is the pole, +X is longitude 0.
  orient(b, q = new THREE.Quaternion()) {
    let spin = (b.spinPhase ?? 0) + (b.rotation ? (2 * Math.PI * this.t) / b.rotation : 0)
    if (b.locked) {                                      // tidally locked: longitude 0 faces the parent
      const d = b.parent.p.sub(b.p), P = b.orbit.plane
      spin = Math.atan2(P[1] * d[0] + P[4] * d[1] + P[7] * d[2], P[0] * d[0] + P[3] * d[1] + P[6] * d[2])
    }
    return q.setFromRotationMatrix(mat4(b.equator).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2)).multiply(new THREE.Matrix4().makeRotationY(spin)))
  }

  // Place everything relative to the camera.
  // focus: the body the camera rides with; close to it only its own moons' orbits are drawn
  place(cam, showOrbits, focus = null) {
    const t = this.t, rel = [0, 0, 0]
    placeStarOrbits(this, cam, showOrbits)
    for (const b of this.bodies) {
      b.p.sub(cam, rel)
      b.group.position.set(rel[0] / KM, rel[1] / KM, rel[2] / KM)
      b.dist = Math.hypot(...rel)
      if (!b.orbit) continue
      this.orient(b, b.mesh.quaternion)
      const { dir, rgb, light } = starLight(this, b.p)        // every star, weighted by flux
      b.u.sun.value.set(...dir)
      b.u.sunCol.value.setRGB(...rgb)
      b.u.light.value = light
      b.center.value.copy(b.group.position)
      for (const x of b.extras) { x.sun.value.copy(b.u.sun.value); x.light.value = light }
      // orbit line: centred on the parent, shown when the camera is in the neighbourhood
      b.parent.p.sub(cam, rel)
      b.orbitLine.position.set(rel[0] / KM, rel[1] / KM, rel[2] / KM)
      const near = Math.hypot(...rel) < b.orbit.a * (b.type === 'moon' ? 40 : 400)
      const close = focus && focus.p.dist(cam) < focus.radius * 60 && b.parent !== focus
      b.orbitLine.visible = showOrbits && near && !close && b.dist > b.radius * 30
    }
  }

  dispose() {
    this.scene.remove(this.root)
    const lib = this.scene.userData.shaderLibrary ??= this.scene.add(Object.assign(new THREE.Group(), { visible: false })).children.at(-1)
    for (const o of [...this.root.children]) {
      const v = o.userData.variant
      if (v && !kept.has(v)) { kept.add(v); lib.add(o); continue }
      o.traverse(x => { if (x.geometry && x.geometry !== SPHERE && x.geometry !== LOW_SPHERE) x.geometry.dispose(); x.material?.dispose() })
    }
  }
}

function mat4(m) {
  return new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1)
}
