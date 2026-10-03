// Large-scale structure. A jittered lattice of nodes (galaxy clusters) joined to their nearest
// neighbours by filaments; galaxies are scattered around nodes and along filaments. Every cell is
// a pure function of its index, so the web is infinite in principle and bounded here by the
// observable universe. Units in this module: megaparsecs.
import * as THREE from 'three/webgpu'
import { uniform, Fn, vec4, vec3, positionLocal, normalize, mx_noise_float, abs, dot, normalView, positionView, pow, float } from 'three/tsl'
import { Rng, hash, fbm3, word } from './rng.js'
import { galaxySprites, blobSprites, upload } from './sprites.js'
import { REAL_GALAXIES, MILKY_WAY } from './catalog.js'
import { MPC, LY, OBSERVABLE_RADIUS } from './units.js'

export const WEB_CELL = 24                       // Mpc between cluster nodes
const OBS = OBSERVABLE_RADIUS / MPC
const LY_PER_MPC = MPC / LY
const EXCLUDE = 2.2                              // Mpc around the Milky Way kept for the real Local Group

// ---- nodes and filaments ---------------------------------------------------------------------
const nodeCache = new Map()
export function node(i, j, k) {
  const key = ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048)
  let n = nodeCache.get(key)
  if (n) return n
  const r = new Rng(hash(i, j, k, 4242))
  // node richness follows a smooth field, so there are superclusters and big voids
  const f = fbm3(i * 0.23, j * 0.23, k * 0.23, 3, 77)
  const alive = r.next() < 0.35 + 1.1 * f
  n = alive ? {
    i, j, k, alive,
    p: [(i + 0.15 + 0.7 * r.next()) * WEB_CELL, (j + 0.15 + 0.7 * r.next()) * WEB_CELL, (k + 0.15 + 0.7 * r.next()) * WEB_CELL],
    m: Math.exp(r.gauss() * 0.8) * (0.4 + 1.6 * f),
  } : { i, j, k, alive }
  if (nodeCache.size > 400000) nodeCache.clear()
  nodeCache.set(key, n)
  return n
}
function neighbours(n) {
  if (n.nb) return n.nb
  const out = []
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    if (!a && !b && !c) continue
    const o = node(n.i + a, n.j + b, n.k + c)
    if (o.alive) out.push([o, Math.hypot(o.p[0] - n.p[0], o.p[1] - n.p[1], o.p[2] - n.p[2])])
  }
  out.sort((x, y) => x[1] - y[1])
  return (n.nb = out.slice(0, 3).map(x => x[0]))
}
const linked = (a, b) => neighbours(a).includes(b) || neighbours(b).includes(a)
const before = (a, b) => a.i < b.i || (a.i === b.i && (a.j < b.j || (a.j === b.j && a.k < b.k)))

// Schechter-like luminosity (units of L*): many dwarfs, few giants
const lumSample = rng => (2.659 - rng.next() * 1.99) ** -4

// ---- galaxies of one lattice cell --------------------------------------------------------------
// Returned arrays are sorted brightest first, so far cells can use a prefix.
export function cellGalaxies(i, j, k) {
  const n = node(i, j, k)
  const list = [], blobs = []                    // blobs: aggregate glow of clusters and filaments [x,y,z,size,lum]
  const rng = new Rng(hash(i, j, k, 9001))
  const add = (x, y, z, L, ell) => {
    if (Math.hypot(x, y, z) < EXCLUDE) return
    list.push({ x, y, z, L, ell, seed: rng.int(1, 2 ** 30) })
  }
  if (n.alive) {
    const count = rng.poisson(n.m * 22)
    const sig = 0.7 * Math.cbrt(n.m)
    if (count > 12) add(n.p[0], n.p[1], n.p[2], 4 + rng.next() * 6, true)      // brightest cluster galaxy
    blobs.push([n.p[0], n.p[1], n.p[2], 2.2 * sig + 1, 0.01 * Math.min(n.m, 5) ** 1.5])
    for (let s = 0; s < count; s++) {
      const L = lumSample(rng)
      add(n.p[0] + rng.gauss() * sig, n.p[1] + rng.gauss() * sig, n.p[2] + rng.gauss() * sig, L, rng.next() < 0.3 + 0.5 * Math.min(1, count / 60))
    }
    for (const o of neighbours(n).concat(backLinks(n))) {
      if (!before(n, o) || !linked(n, o)) continue
      const len = Math.hypot(o.p[0] - n.p[0], o.p[1] - n.p[1], o.p[2] - n.p[2])
      const cnt = rng.poisson(len * 1.4 * Math.sqrt(n.m * o.m))
      const strength = 0.0035 * n.m * o.m * Math.exp(rng.gauss() * 0.6)        // filaments vary a lot
      const bend = [rng.gauss() * 2.5, rng.gauss() * 2.5, rng.gauss() * 2.5]
      for (let t = 0.1; t < 0.92; t += 1.5 / len) {
        const s = Math.sin(Math.PI * t)
        blobs.push([n.p[0] + (o.p[0] - n.p[0]) * t + bend[0] * s, n.p[1] + (o.p[1] - n.p[1]) * t + bend[1] * s, n.p[2] + (o.p[2] - n.p[2]) * t + bend[2] * s,
          1.4 + 1.3 * s * rng.next(), strength * (0.25 + 0.5 * rng.next())])
      }
      for (let s = 0; s < cnt; s++) {
        const t = rng.next(), w = 0.25 + 1.1 * Math.sin(Math.PI * t)
        add(n.p[0] + (o.p[0] - n.p[0]) * t + rng.gauss() * w, n.p[1] + (o.p[1] - n.p[1]) * t + rng.gauss() * w,
          n.p[2] + (o.p[2] - n.p[2]) * t + rng.gauss() * w, lumSample(rng), rng.next() < 0.15)
      }
    }
  }
  const field = rng.poisson(6)
  for (let s = 0; s < field; s++) add((i + rng.next()) * WEB_CELL, (j + rng.next()) * WEB_CELL, (k + rng.next()) * WEB_CELL, lumSample(rng) * 0.5, false)
  list.sort((a, b) => b.L - a.L)
  list.blobs = blobs
  return list
}
// nodes that chose n as a nearest neighbour without n choosing them
function backLinks(n) {
  const out = []
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const o = node(n.i + a, n.j + b, n.k + c)
    if (o !== n && o.alive && neighbours(o).includes(n) && !neighbours(n).includes(o)) out.push(o)
  }
  return out
}

// Full galaxy description (shared with the galaxy layer) from a web record.
export function galaxyFromRecord(rec, cellKey) {
  const rng = new Rng(rec.seed)
  const R = 52000 * rec.L ** 0.35
  const n = rng.dir()
  const ell = rec.ell
  const arms = ell ? 0 : rng.pick([2, 2, 2, 3, 4])
  const code = `${word(rng, 2).toUpperCase().slice(0, 3)} ${rng.int(1000, 9999)}${ell ? 'E' : 'S'}`
  return {
    id: 'g' + rec.seed, name: code, type: ell ? 'elliptical' : 'spiral', R, arms: Math.max(arms, 1), pitch: (10 + rng.next() * 16) * Math.PI / 180,
    phase: rng.next() * 6.28, hR: R / 5, hz: R / 55, bulge: R * (0.06 + rng.next() * 0.08), bar: rng.next() < 0.5 ? R * 0.2 : 0, barAngle: rng.next() * 6.28,
    seed: rec.seed, lum: rec.L, normal: n, posMpc: [rec.x, rec.y, rec.z], cellKey,
  }
}

// ---- rendering -------------------------------------------------------------------------------
function packGalaxy(out, m, x, y, z, g) {
  const rng = new Rng(g.seed ^ 0x5bd1)
  out.pos.set([x, y, z], m * 3)
  out.nrm.set(g.normal, m * 3)
  out.size[m] = g.R / LY_PER_MPC
  out.lum[m] = 0.45 * (g.lum ?? 1) ** 0.15
  const warm = g.type === 'elliptical' ? 1 : 0.35 + 0.3 * rng.next()
  out.col.set([1, 0.9 + 0.1 * (1 - warm), 0.8 + 0.3 * (1 - warm)], m * 3)
  out.shape.set([g.type === 'elliptical' ? 1 : 0, g.arms, Math.tan(g.pitch), (g.seed % 1000) / 1000], m * 4)
}
function galaxyBuffers(n) {
  return { pos: new Float32Array(n * 3), nrm: new Float32Array(n * 3), size: new Float32Array(n), lum: new Float32Array(n), col: new Float32Array(n * 3), shape: new Float32Array(n * 4) }
}
const uploadGal = (s, b, n) => upload(s.geometry, { iPos: b.pos, iNormal: b.nrm, iSize: b.size, iLum: b.lum, iColor: b.col, iShape: b.shape }, n)

export class Cosmos {
  constructor(scene) {
    this.near = { reach: 90, all: true }
    this.far = { reach: 270, all: false }
    this.cells = new Map()                         // key -> { list, g? }
    this.web = galaxySprites(420000, { gain: 1 })
    this.glow = blobSprites(300000, { gain: 1, fadeNear: [6, 18], maxPx: 70 })
    this.named = galaxySprites(REAL_GALAXIES.length + 1, { gain: 1 })
    this.cloud = this.buildFarCloud()
    this.cmb = this.buildCMB()
    scene.add(this.cloud.mesh, this.glow.mesh, this.web.mesh, this.named.mesh, this.cmb)
    this.web.mesh.renderOrder = 2; this.named.mesh.renderOrder = 3
    this.anchor = [0, 0, 0]
    this.key = ''
    this.namedList = [{ ...MILKY_WAY, pos: MILKY_WAY.centerLy.map(v => v * LY) }, ...REAL_GALAXIES]
    const b = galaxyBuffers(this.namedList.length)
    this.namedList.forEach((g, m) => packGalaxy(b, m, ...g.pos.map(v => v / MPC), g))
    uploadGal(this.named, b, this.namedList.length)
  }

  // Beyond the streamed web: one static cloud of "galaxy groups" filling the observable sphere.
  buildFarCloud() {
    const N = 450000, rng = new Rng(31337)
    const b = { pos: new Float32Array(N * 3), col: new Float32Array(N * 3), lum: new Float32Array(N), size: new Float32Array(N) }
    let n = 0
    while (n < N) {
      const r = OBS * Math.cbrt(rng.next())
      const [dx, dy, dz] = rng.dir()
      const x = dx * r, y = dy * r, z = dz * r
      const f = fbm3(x / 160, y / 160, z / 160, 4, 5)
      if (rng.next() > (f - 0.28) * 2.6) continue
      b.pos.set([x, y, z], n * 3)
      const warm = rng.next()
      b.col.set([1, 0.85 + 0.1 * warm, 0.72 + 0.25 * warm], n * 3)
      b.lum[n] = 0.012
      b.size[n] = 7 + rng.next() * 9
      n++
    }
    const s = blobSprites(N, { gain: 1, fadeNear: [this.far.reach * 0.75, this.far.reach * 1.05], maxPx: 40 })
    upload(s.geometry, { iPos: b.pos, iColor: b.col, iLum: b.lum, iSize: b.size }, N)
    s.mesh.renderOrder = 1
    return s
  }

  // The edge of the observable universe: the surface of last scattering, seen from outside.
  buildCMB() {
    const geo = new THREE.SphereGeometry(OBS, 96, 48)
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, side: THREE.FrontSide, blending: THREE.AdditiveBlending })
    this.cmbOpacity = uniform(0)
    mat.colorNode = cmbColor(this.cmbOpacity)
    return new THREE.Mesh(geo, mat)
  }

  cellKey(i, j, k) { return i + ',' + j + ',' + k }

  // Stream cells around the camera (Mpc). Time-sliced; re-packs instance buffers on change.
  update(cam, budget = 6) {
    const t0 = performance.now()
    const ci = Math.floor(cam[0] / WEB_CELL), cj = Math.floor(cam[1] / WEB_CELL), ck = Math.floor(cam[2] / WEB_CELL)
    const R = Math.ceil(this.far.reach / WEB_CELL)
    const key = ci + ',' + cj + ',' + ck
    if (key !== this.key) {
      this.key = key
      this.want = []
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) for (let k = -R; k <= R; k++) {
        const d = Math.hypot(i, j, k) * WEB_CELL
        if (d > this.far.reach + WEB_CELL) continue
        const x = (ci + i + 0.5) * WEB_CELL, y = (cj + j + 0.5) * WEB_CELL, z = (ck + k + 0.5) * WEB_CELL
        if (Math.hypot(x, y, z) > OBS + WEB_CELL) continue
        this.want.push([ci + i, cj + j, ck + k, d])
      }
      this.want.sort((a, b) => a[3] - b[3])
      this.dirty = true
    }
    let added = 0
    for (const [i, j, k] of this.want) {
      const key = this.cellKey(i, j, k)
      if (this.cells.has(key)) continue
      if (performance.now() - t0 > budget) break
      this.cells.set(key, { i, j, k, list: cellGalaxies(i, j, k) }); added++
    }
    // re-pack when the view moved a cell, or every half second while new cells stream in
    const now = performance.now()
    const due = this.dirty || (added && now - (this.packedAt || 0) > 500) || (this.unpacked && !added)
    if (due && (this.hidden || this.job)) this.unpacked = true   // hidden inside a galaxy, or a pack is running: pack later
    else if (due) { this.job = this.packing(cam); this.packedAt = now; this.unpacked = false }
    else if (added) this.unpacked = true
    // a full pack is 50-300 ms of work: run it 3 ms a frame; the old buffers stay on screen until it is done
    for (const t = performance.now(); this.job && performance.now() - t < 3;) if (this.job.next().done) this.job = null
    this.dirty = false
    if (this.cells.size > this.want.length * 1.5) {
      const keep = new Set(this.want.map(([i, j, k]) => this.cellKey(i, j, k)))
      for (const key of this.cells.keys()) if (!keep.has(key)) this.cells.delete(key)
    }
  }

  // Pack the streamed cells into the instance buffers around cam, yielding every 256 galaxies (update() runs it in
  // slices). Positions are relative to the new anchor, which takes over only with the finished upload.
  *packing(cam) {
    const cap = 420000
    const b = this.buf || (this.buf = galaxyBuffers(cap))
    const anchor = [cam[0], cam[1], cam[2]], cells = [...this.cells.values()]
    let m = 0
    for (const cell of cells) {
      const cx = (cell.i + 0.5) * WEB_CELL - cam[0], cy = (cell.j + 0.5) * WEB_CELL - cam[1], cz = (cell.k + 0.5) * WEB_CELL - cam[2]
      const d = Math.hypot(cx, cy, cz)
      if (d > this.far.reach + WEB_CELL) continue
      // far cells only show their bright members
      const minL = d < this.near.reach ? 0 : 0.35 * ((d - this.near.reach) / (this.far.reach - this.near.reach) + 1) ** 2
      for (const rec of cell.list) {
        if (rec.L < minL || m >= cap) break
        const g = rec.g || (rec.g = galaxyFromRecord(rec, this.cellKey(cell.i, cell.j, cell.k)))
        packGalaxy(b, m++, rec.x - cam[0], rec.y - cam[1], rec.z - cam[2], g)
        if (!(m & 255)) yield
      }
    }
    const gb = this.glowBuf || (this.glowBuf = { pos: new Float32Array(300000 * 3), col: new Float32Array(300000 * 3), lum: new Float32Array(300000), size: new Float32Array(300000) })
    let q = 0
    for (const cell of cells) {
      for (const [x, y, z, s, l] of cell.list.blobs) {
        if (q >= 300000) break
        gb.pos[q * 3] = x - cam[0]; gb.pos[q * 3 + 1] = y - cam[1]; gb.pos[q * 3 + 2] = z - cam[2]
        gb.col[q * 3] = 1; gb.col[q * 3 + 1] = 0.86; gb.col[q * 3 + 2] = 0.74
        gb.lum[q] = l; gb.size[q] = s; q++
      }
      yield
    }
    uploadGal(this.web, b, m)
    upload(this.glow.geometry, { iPos: gb.pos, iColor: gb.col, iLum: gb.lum, iSize: gb.size }, q)
    this.count = m
    this.anchor = anchor
  }

  // Galaxies within `r` Mpc of p (Mpc), streamed or real.
  nearby(p, r, fn) {
    for (const g of this.namedList) {
      const d = Math.hypot(g.pos[0] / MPC - p[0], g.pos[1] / MPC - p[1], g.pos[2] / MPC - p[2])
      if (d < r) fn(g, d)
    }
    const ci = Math.floor(p[0] / WEB_CELL), cj = Math.floor(p[1] / WEB_CELL), ck = Math.floor(p[2] / WEB_CELL)
    const R = Math.ceil(r / WEB_CELL)
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) for (let k = -R; k <= R; k++) {
      const cell = this.cells.get(this.cellKey(ci + i, cj + j, ck + k))
      if (!cell) continue
      for (const rec of cell.list) {
        const d = Math.hypot(rec.x - p[0], rec.y - p[1], rec.z - p[2])
        if (d < r) fn(rec.g || (rec.g = galaxyFromRecord(rec, this.cellKey(cell.i, cell.j, cell.k))), d)
      }
    }
  }

  // Place meshes relative to the camera (camMpc = camera position in Mpc, float64).
  place(camMpc) {
    this.web.mesh.position.set(this.anchor[0] - camMpc[0], this.anchor[1] - camMpc[1], this.anchor[2] - camMpc[2])
    this.glow.mesh.position.copy(this.web.mesh.position)
    this.named.mesh.position.set(-camMpc[0], -camMpc[1], -camMpc[2])
    this.cloud.mesh.position.copy(this.named.mesh.position)
    this.cmb.position.copy(this.named.mesh.position)
    const fromCentre = Math.hypot(...camMpc)
    this.cmbOpacity.value = THREE.MathUtils.smoothstep(fromCentre, 1500, 9000) * 0.5
    this.cloud.u.near0.value = this.far.reach * 0.7
    this.cloud.u.near1.value = this.far.reach
  }

  // 0 = inside a galaxy, 1 = intergalactic space
  setExposure(out) {
    const k = 0.015 + 0.985 * out
    this.web.u.opacity.value = k
    this.glow.u.opacity.value = k
    this.cloud.u.opacity.value = k
    this.named.u.opacity.value = 0.3 + 0.7 * out
    // deep inside a galaxy the faint background is invisible anyway: skip ~1M sprites
    this.hidden = out <= 0.01
    this.web.mesh.visible = this.glow.mesh.visible = this.cloud.mesh.visible = !this.hidden
  }
  galaxyPos(g) { return g.pos ? g.pos.map(v => v / MPC) : g.posMpc }
}

function cmbColor(opacity) {
  return Fn(() => {
    const n = normalize(positionLocal)
    const t = mx_noise_float(n.mul(9)).mul(0.6).add(mx_noise_float(n.mul(23)).mul(0.3)).add(mx_noise_float(n.mul(57)).mul(0.15))
    const hot = vec3(1.0, 0.55, 0.25), cold = vec3(0.25, 0.45, 1.0)
    const rim = pow(float(1).sub(abs(dot(normalView, normalize(positionView)))), 2.5).mul(0.8).add(0.08)
    const c = cold.mix(hot, t.mul(0.5).add(0.5))
    return vec4(c.mul(rim).mul(opacity).mul(0.35), 1)
  })()
}
