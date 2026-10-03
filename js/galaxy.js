// A galaxy = a density model (drives star streaming) + a particle cloud (what you see from
// inside or near it). Both live in the galaxy's own frame, in light years: disk in the xy plane.
import * as THREE from 'three/webgpu'
import { Rng, hash } from './rng.js'
import { blobSprites, upload } from './sprites.js'

const TAU = Math.PI * 2

// Angle of arm k at radius r (logarithmic spiral), and how close a point is to any arm (0..1).
function armAngle(g, r, k) { return Math.log(Math.max(r, 200) / 2000) / Math.tan(g.pitch) + g.phase + (TAU * k) / g.arms }
export function armProfile(g, x, y, field = 'old') {
  if (g.armTable) return realArmProfile(g, x, y, field)
  const r = Math.hypot(x, y), th = Math.atan2(y, x)
  const period = TAU / g.arms
  let d = (th - armAngle(g, r, 0)) % period
  if (d < 0) d += period
  d = Math.min(d, period - d) * r            // distance to the nearest arm along the circle, in ly
  const w = 900 + r * 0.04
  return Math.exp(-(d * d) / (w * w))
}

// ---- Real arms (Milky Way): piecewise log spirals from a published fit (catalog.js armTable).
// Galaxy frame: centre at the origin, Sun at (-R0, 0), so azimuth beta = atan2(y, -x) and the arm
// point at (beta, R) is (-R cos beta, R sin beta).
const D2R = Math.PI / 180
const OLD_WIDEN = 1.7                         // old stars spread wider than the masers that trace the arm centre

// Nodes at every segment boundary: beta (rad) and ln R (ly), integrated outward from the kink.
function arms(g) {
  if (g._arms) return g._arms
  const kpc = 26670 / g.R0kpc
  return (g._arms = g.armTable.map(a => {
    const segs = [...a.segs].sort((p, q) => p[0] - q[0])
    const b = [segs[0][0], ...segs.map(s => s[1])].map(v => v * D2R)
    const lnR = new Array(b.length)
    const k = b.findIndex(v => Math.abs(v - a.kink[0] * D2R) < 1e-9)
    lnR[k] = Math.log(a.kink[1] * kpc)
    for (let i = k + 1; i < b.length; i++) lnR[i] = lnR[i - 1] - (b[i] - b[i - 1]) * Math.tan(segs[i - 1][2] * D2R)
    for (let i = k - 1; i >= 0; i--) lnR[i] = lnR[i + 1] + (b[i + 1] - b[i]) * Math.tan(segs[i][2] * D2R)
    return { ...a, b, lnR, b0: b[0], b1: b[b.length - 1], w0: a.width * kpc, Rk: a.kink[1] * kpc }
  }))
}
// Arm radius (ly) at azimuth beta (rad), inside the arm's range.
function armR(a, beta) {
  let i = 0
  while (i < a.b.length - 2 && beta > a.b[i + 1]) i++
  const t = (beta - a.b[i]) / (a.b[i + 1] - a.b[i])
  return Math.exp(a.lnR[i] + (a.lnR[i + 1] - a.lnR[i]) * t)
}
// Arms taper over their last ~30 degrees instead of stopping dead.
const armEnds = (a, beta) => Math.min(1, (beta - a.b0) / 0.5, (a.b1 - beta) / 0.5)
// Gaussian sigma (ly): Reid's width at the kink growing 42 pc per kpc of radius.
const armSigma = (a, R) => a.w0 + 0.042 * (R - a.Rk)

function realArmProfile(g, x, y, field) {
  const r = Math.hypot(x, y), beta = Math.atan2(y, -x)
  let best = 0
  for (const a of arms(g)) {
    for (let b = beta + Math.ceil((a.b0 - beta) / TAU) * TAU; b <= a.b1; b += TAU) {
      const R = armR(a, b), s = armSigma(a, R) * OLD_WIDEN, d = r - R
      const v = a[field] * armEnds(a, b) * Math.exp(-(d * d) / (2 * s * s))
      if (v > best) best = v
    }
  }
  return best
}

// A point on a real arm drawn by star-formation weight: [r, th, sigma] in the galaxy frame.
export function armSample(g, rng) {
  const list = arms(g)
  const total = list.reduce((s, a) => s + a.young * (a.b1 - a.b0), 0)
  for (;;) {
    let u = rng.next() * total, a = list[0]
    for (const x of list) { a = x; u -= x.young * (x.b1 - x.b0); if (u <= 0) break }
    const beta = rng.range(a.b0, a.b1), R = armR(a, beta)
    // arc length grows with R; star formation falls off with the disk scale length
    if (rng.next() > (R / g.hR) * Math.exp(1 - R / g.hR) * armEnds(a, beta)) continue
    return [R, Math.PI - beta, armSigma(a, R)]
  }
}

// The long bar as a stellar density (thin, flat-topped, tapering to its tips).
function barDensity(g, x, y, z) {
  const cb = Math.cos(g.barAngle), sb = Math.sin(g.barAngle)
  const a = Math.abs(x * cb + y * sb) / g.bar, b = (-x * sb + y * cb) / (g.bar * 0.08)
  return a < 1 ? 30 * (1 - a * a) * Math.exp(-b * b) * Math.exp(-Math.abs(z) / 600) : 0
}

// Stellar density relative to the solar neighbourhood (1 = 0.004 stars per cubic light year).
export function density(g, x, y, z) {
  if (g.type === 'elliptical') {
    const m = Math.hypot(x, y / 0.8, z / 0.7) / (g.R * 0.18)
    return 60 * Math.exp(-3 * Math.sqrt(m))
  }
  const r = Math.hypot(x, y)
  // real arms are normalised so the solar neighbourhood stays at 1
  const norm = g.armTable ? (g._norm ??= 1 / (0.6 + 0.9 * armProfile(g, -26670, 0))) : 1
  const disk = Math.exp(-(r - 26670 * (g.hR / 8500)) / g.hR) * Math.exp(-Math.abs(z) / (g.hz * 1.1)) * (0.6 + 0.9 * armProfile(g, x, y)) * norm
  const b = Math.hypot(x, y, z * 1.6) / g.bulge
  const bulge = 250 * Math.exp(-b * b) + (g.armTable ? barDensity(g, x, y, z) : 0)
  return (disk + bulge) * (r < g.R * 1.3 ? 1 : Math.exp(-(r - g.R * 1.3) / g.hR))
}

// ---- Particle cloud generation --------------------------------------------------------------
const OLD = [1.0, 0.78, 0.55], YOUNG = [0.68, 0.8, 1.0], MID = [1.0, 0.93, 0.85], HII = [1.0, 0.45, 0.62], DUST = [0.014, 0.01, 0.008]

function pushP(out, x, y, z, c, lum, size) {
  const i = out.n++
  out.pos[i * 3] = x; out.pos[i * 3 + 1] = y; out.pos[i * 3 + 2] = z
  out.col[i * 3] = c[0]; out.col[i * 3 + 1] = c[1]; out.col[i * 3 + 2] = c[2]
  out.lum[i] = lum; out.size[i] = size
}
function buffers(n) { return { n: 0, pos: new Float32Array(n * 3), col: new Float32Array(n * 3), lum: new Float32Array(n), size: new Float32Array(n) } }
const laplace = rng => (rng.next() < 0.5 ? -1 : 1) * rng.exp()
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

// Star-forming knots on the real arms, with a few feathers trailing off them.
function realKnots(g, rng, n) {
  const S = g.R / 52000, out = []
  for (let k = 0; k < n; k++) {
    const [R, th0, sig] = armSample(g, rng)
    const r = R + rng.gauss() * sig * 0.6
    let th = th0 + (rng.gauss() * 300 * S) / r
    if (rng.next() < 0.12) th -= rng.range(0.05, 0.3) * (r / g.R)
    out.push([r, th, (220 + rng.next() * 650) * S])
  }
  return out
}

export function buildCloud(g, scale = 1) {
  const rng = new Rng(hash(g.seed, 99))
  const N = Math.round((g.id === 'milky-way' ? 420000 : 260000) * scale)
  const stars = buffers(N), haze = buffers(Math.round(N * 0.12)), dust = buffers(Math.round(N * 0.2))
  const S = g.R / 52000                                     // everything scales with the galaxy size
  const cb = Math.cos(g.barAngle || 0), sb = Math.sin(g.barAngle || 0)

  if (g.type === 'elliptical') {
    for (let i = 0; i < N; i++) {
      const r = g.R * 0.1 * Math.pow(rng.exp() + rng.exp() + rng.exp(), 2) / 4
      const [dx, dy, dz] = rng.dir()
      const c = mixc(OLD, MID, rng.next() * 0.4)
      pushP(stars, dx * r, dy * r * 0.8, dz * r * 0.7, c, 0.018, 320 * S + r * 0.03)
      if (i % 8 === 0) pushP(haze, dx * r, dy * r * 0.8, dz * r * 0.7, OLD, 0.004, 2400 * S)
    }
    return { stars, haze, dust }
  }

  // star-forming knots strung along wiggly arms, plus spurs branching between them
  const knots = g.armTable ? realKnots(g, rng, 3600) : []
  for (let k = 0; k < (g.armTable ? 0 : g.arms * 900); k++) {
    const arm = k % g.arms
    const r = Math.min(g.hR * (rng.exp() + rng.exp()) * 0.85 + g.bulge * 0.8, g.R * 1.1)
    let th = armAngle(g, r, arm) + 0.16 * Math.sin(r / (2600 * S) + arm * 1.7) + 0.07 * Math.sin(r / (800 * S) + arm * 4.1)
    th += (rng.gauss() * (900 * S + 0.07 * r)) / Math.max(r, 1)
    if (rng.next() < 0.22) th += rng.range(0.1, 0.45) * (r / g.R)
    knots.push([r, th, (220 + rng.next() * 650) * S])
  }
  const bulgeFrac = g.armTable ? 0.05 : 0.13, barFrac = g.armTable ? 0.13 : 0.07
  for (let i = 0; i < N; i++) {
    const u = rng.next()
    if (u < bulgeFrac) {                                    // bulge: flattened gaussian
      const x = rng.gauss() * g.bulge * 0.7, y = rng.gauss() * g.bulge * 0.6, z = rng.gauss() * g.bulge * 0.42
      pushP(stars, x, y, z, mixc(OLD, MID, rng.next() * 0.3), 0.012, 260 * S)
      if (i % 6 === 0) pushP(haze, x * 1.3, y * 1.3, z * 1.3, OLD, 0.006, 2200 * S)
      continue
    }
    if (u < bulgeFrac + barFrac) {                          // bar
      const a = g.armTable ? (rng.next() + rng.next() - 1) * g.bar : rng.gauss() * g.bar * 0.5
      const b = rng.gauss() * g.bar * (g.armTable ? 0.07 : 0.12), z = rng.gauss() * g.hz * 0.5
      pushP(stars, a * cb - b * sb, a * sb + b * cb, z, mixc(OLD, MID, 0.4), 0.02, 260 * S)
      if (g.armTable && i % 6 === 0) pushP(haze, a * cb - b * sb * 1.5, a * sb + b * cb * 1.5, z, OLD, 0.005, 1600 * S)
      continue
    }
    if (rng.next() < 0.55) {                                // young stars: clumped around knots on the arms
      const [kr, kth, ks] = knots[rng.int(0, knots.length - 1)]
      const x = kr * Math.cos(kth) + rng.gauss() * ks, y = kr * Math.sin(kth) + rng.gauss() * ks, z = laplace(rng) * g.hz * 0.25
      const fresh = rng.next()
      pushP(stars, x, y, z, mixc(MID, YOUNG, 0.5 + 0.5 * fresh), 0.03 + 0.03 * fresh, 170 * S)
      if (fresh > 0.93) pushP(stars, x, y, z * 0.5, HII, 0.25, 40 * S)
      if (i % 7 === 0) pushP(haze, x, y, z, mixc(MID, YOUNG, 0.6), 0.004, 1300 * S)
      if (rng.next() < 0.3 && dust.n < dust.lum.length) {  // dust hugs the inner edge of the arm
        const dr = kr - 380 * S + rng.gauss() * ks * 0.6, dth = kth + rng.gauss() * ks / Math.max(kr, 1)
        pushP(dust, dr * Math.cos(dth), dr * Math.sin(dth), laplace(rng) * g.hz * 0.08, DUST, 0.05 + 0.07 * rng.next(), 150 * S)
      }
      continue
    }
    // old disk: smooth exponential, only gently modulated by the density wave
    const r = Math.min(g.hR * (rng.exp() + rng.exp()) * 0.8, g.R * 1.15), th = rng.next() * TAU
    const x = r * Math.cos(th), y = r * Math.sin(th)
    if (rng.next() > 0.55 + 0.45 * armProfile(g, x, y)) { i--; continue }
    if (g.armTable && r < g.bar && rng.next() > 0.25 + 0.75 * r / g.bar) { i--; continue }   // the bar has swept the inner disk
    pushP(stars, x, y, laplace(rng) * g.hz * 0.9, mixc(OLD, MID, 0.3 + 0.5 * (r / g.R)), 0.014, 300 * S)
    if (i % 9 === 0) pushP(haze, x, y, laplace(rng) * g.hz * 1.5, OLD, 0.004, 1500 * S)
  }
  return { stars, haze, dust }
}

// ---- Renderable cloud in the galaxy layer (units: ly) --------------------------------------
export class GalaxyCloud {
  constructor(g) {
    this.g = g
    const data = buildCloud(g)
    this.group = new THREE.Group()
    const make = (b, opts) => {
      const s = blobSprites(b.n, opts)
      upload(s.geometry, { iPos: b.pos, iColor: b.col, iLum: b.lum, iSize: b.size }, b.n)
      this.group.add(s.mesh)
      return s
    }
    // near fade: close star clouds give way to individually streamed stars
    const S = g.R / 52000
    this.haze = make(data.haze, { gain: 1, fadeNear: [4000 * S, 12000 * S], maxPx: 70 })
    this.stars = make(data.stars, { gain: 1, fadeNear: [1500 * S, 5000 * S], maxPx: 28 })
    this.dust = make(data.dust, { gain: 1, fadeNear: [1200 * S, 4000 * S], maxPx: 40, dark: true })
    this.stars.mesh.renderOrder = 1; this.dust.mesh.renderOrder = 2
    const n = g.normal || [0, 0, 1]
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...n))
  }
  set opacity(a) { this.haze.u.opacity.value = a; this.stars.u.opacity.value = a; this.dust.u.opacity.value = a; this.group.visible = a > 0.002 }
  // eye adaptation: from inside, the long in-plane sight lines are far brighter than a disk seen from outside
  set gain(k) { this.haze.u.gain.value = k; this.stars.u.gain.value = k }
  dispose() { this.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose() }) }
}

// Rotation (row-major 3x3) from galaxy frame to universe axes, matching the cloud's quaternion.
export function galaxyRot(g) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...(g.normal || [0, 0, 1])))
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements   // column-major
  return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]
}
