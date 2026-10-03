// Deep-sky objects: real nebulae and star clusters placed by RA/Dec/distance, plus procedural HII
// regions and young clusters strung along the Milky Way's arms (galaxy layer, light years).
// Each named object is its own group, built in "sky" axes as in a north-up photo (x west, y north,
// z away from Earth) and placed camera-relative every frame, so float32 stays precise up close.
import * as THREE from 'three/webgpu'
import { Fn, attribute, uniform, vec3, vec4, float, positionGeometry, modelViewMatrix, varyingProperty, length, max, min, exp, smoothstep, clamp, select, fract, mx_noise_float } from 'three/tsl'
import { quadGeometry, billboard, spriteMesh, starSprites, upload, tempColor, view } from './sprites.js'
import { fromRaDec, MILKY_WAY } from './catalog.js'
import { armSample } from './galaxy.js'
import { Rng, hash, fbm3 } from './rng.js'
import { LY } from './units.js'
import { UPos } from './upos.js'

const HA = [1.0, 0.2, 0.3], PINK = [1.0, 0.42, 0.55], OIII = [0.2, 0.85, 0.78], SII = [1.0, 0.38, 0.12]
const REFL = [0.35, 0.55, 1.0], HOT = [1.0, 0.9, 0.88], SYNC = [0.6, 0.72, 1.0], GLOW = [1.0, 0.8, 0.55], DUST = [0.02, 0.012, 0.01]
const GAS_GAIN = 0.55                          // overall surface brightness of the glowing gas
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

// ---- Gas sprites: soft blobs like blobSprites, but every instance fades out once it is bigger than
// maxPx on screen (smaller blobs take over up close, so overdraw stays bounded) or the camera is in it.
function gasSprites(capacity, { dark = false, maxPx = 80 } = {}) {
  const g = quadGeometry(capacity, { iPos: 3, iColor: 3, iLum: 1, iSize: 1 })
  const u = { opacity: uniform(1), maxPx: uniform(maxPx) }
  const vS = varyingProperty('float', 'vS'), vUv = varyingProperty('vec2', 'vUv'), vCol = varyingProperty('vec3', 'vCol'), vSeed = varyingProperty('float', 'vSeed')
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending })
  mat.vertexNode = Fn(() => {
    const vc = modelViewMatrix.mul(vec4(attribute('iPos', 'vec3'), 1)).xyz.toVar()
    const size = attribute('iSize', 'float')
    vSeed.assign(fract(attribute('iPos', 'vec3').dot(vec3(12.9898, 78.233, 37.719))).mul(97))
    const pxR = size.mul(view.pxPerRad).div(max(vc.z.negate(), 1e-6)).toVar()
    const r = clamp(pxR, 1.0, u.maxPx).toVar()
    const unresolved = min(pxR.div(r), 1).pow(2)
    const fade = smoothstep(u.maxPx.mul(2), u.maxPx, pxR).mul(smoothstep(size.mul(0.5), size.mul(2), length(vc)))
    const S = attribute('iLum', 'float').mul(unresolved).mul(fade).mul(u.opacity).toVar()
    vS.assign(S); vUv.assign(positionGeometry.xy); vCol.assign(attribute('iColor', 'vec3'))
    return billboard(vc, select(S.lessThan(dark ? 0.004 : 0.0004), float(0), r.mul(1.6)))
  })()
  // a gaussian puff mottled by noise unique to each blob, so overlapping blobs read as wisps, not balls
  const shape = Fn(() => {
    const q = length(vUv).mul(1.6), n = mx_noise_float(vec3(vUv.mul(1.8), vSeed)).mul(0.5).add(0.5)
    return exp(q.mul(q).mul(-1.4)).mul(smoothstep(1, 0.8, length(vUv))).mul(dark ? n.add(0.5) : n.mul(n).mul(2.2))
  })
  mat.colorNode = dark ? Fn(() => vec4(vCol, min(vS.mul(shape()), 0.92)))() : Fn(() => vec4(vCol.mul(vS).mul(shape()), 1))()
  return { mesh: spriteMesh(g, mat), u, geometry: g }
}

// Collects blobs and stars in sky axes and converts them to galactic axes (E, N, V unit vectors).
class Builder {
  constructor(axes) { this.ax = axes; this.gasB = []; this.nearB = []; this.farB = []; this.starB = [] }
  gal(p) {
    if (!this.ax) return p
    const [E, N, V] = this.ax
    return [0, 1, 2].map(i => -p[0] * E[i] + p[1] * N[i] + p[2] * V[i])
  }
  gas(p, col, lum, size) { this.gasB.push(...this.gal(p), ...col, lum, size) }
  dust(p, alpha, size) { (p[2] < 0 ? this.nearB : this.farB).push(...this.gal(p), ...DUST, alpha, size) }
  star(p, [T, L]) { this.starB.push(...this.gal(p), ...tempColor(T), L) }
  // sky position of another RA/Dec/distance relative to this object's centre
  sky(ra, dec, ly) {
    const d = fromRaDec(ra, dec, ly).map((v, i) => v - this.center[i]), [E, N, V] = this.ax
    const dot = a => d[0] * a[0] + d[1] * a[1] + d[2] * a[2]
    return [-dot(E), dot(N), dot(V)]
  }
}

function gasMesh(arr, dark) {
  const n = arr.length / 8
  if (!n) return null
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), lum = new Float32Array(n), size = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    pos.set(arr.slice(i * 8, i * 8 + 3), i * 3); col.set(arr.slice(i * 8 + 3, i * 8 + 6), i * 3)
    lum[i] = arr[i * 8 + 6]; size[i] = arr[i * 8 + 7]
  }
  const s = gasSprites(n, { dark, maxPx: dark ? 60 : 80 })
  if (!dark) lum.forEach((v, i) => { lum[i] = v * GAS_GAIN })
  upload(s.geometry, { iPos: pos, iColor: col, iLum: lum, iSize: size }, n)
  return s
}
function starMesh(arr) {
  const n = arr.length / 7
  if (!n) return null
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), lum = new Float32Array(n)
  for (let i = 0; i < n; i++) { pos.set(arr.slice(i * 7, i * 7 + 3), i * 3); col.set(arr.slice(i * 7 + 3, i * 7 + 6), i * 3); lum[i] = arr[i * 7 + 6] }
  const s = starSprites(n, { gain: 100, hideNear: 0.01 })
  upload(s.geometry, { iPos: pos, iColor: col, iLum: lum }, n)
  return s
}

// ---- Point generators: each calls fn(p, ...) for n accepted points ---------------------------------
// ridged noise: 1 on thin sheets (wisps in projection), 0 between them
const ridge = (p, s, seed) => Math.max(0, 1 - Math.abs(fbm3(p[0] / s + 40, p[1] / s + 40, p[2] / s + 40, 3, seed) - 0.5) * 7)
const wispy = (rng, p, o) => !o.wisp || rng.next() < ridge(p, o.scale || 1, o.seed || 0) ** (1 + 5 * o.wisp)

function cloud(rng, o, fn) {
  const at = o.at || [0, 0, 0]
  for (let i = 0, t = 0; i < o.n && t < o.n * 40; t++) {
    const p = add(at, [rng.gauss() * o.r[0], rng.gauss() * o.r[1], rng.gauss() * o.r[2]])
    if (wispy(rng, p, o)) fn(p, i++)
  }
}
function shell(rng, o, fn) {
  const at = o.at || [0, 0, 0]
  for (let i = 0, t = 0; i < o.n && t < o.n * 40; t++) {
    const d = rng.dir(), s = Math.max(0.2, 1 + rng.gauss() * o.thick)
    const p = add(at, [d[0] * o.R[0] * s, d[1] * o.R[1] * s, d[2] * o.R[2] * s])
    if (wispy(rng, p, o)) fn(p, s)
  }
}
// along a polyline, thinning toward the end by `taper`
function path(rng, pts, o, fn) {
  const len = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]))
  const total = len.reduce((a, b) => a + b, 0)
  for (let i = 0; i < o.n; i++) {
    let s = rng.next() * total, k = 0
    while (k < len.length - 1 && s > len[k]) s -= len[k++]
    const a = pts[k], b = pts[k + 1], f = s / len[k], t = (len.slice(0, k).reduce((x, y) => x + y, 0) + s) / total
    const w = o.width * (1 - (o.taper || 0) * t)
    fn([a[0] + (b[0] - a[0]) * f + rng.gauss() * w, a[1] + (b[1] - a[1]) * f + rng.gauss() * w, a[2] + (b[2] - a[2]) * f + rng.gauss() * w], t)
  }
}
// elliptical torus/barrel around the line of sight, tilted by `tilt` (rad) about the sky x axis, then
// turned by `pa` in the sky; fn gets the radial position relative to the ring (1 = on it)
function torus(rng, o, fn) {
  const ct = Math.cos(o.tilt || 0), st = Math.sin(o.tilt || 0), cp = Math.cos(o.pa || 0), sp = Math.sin(o.pa || 0)
  for (let i = 0; i < o.n; i++) {
    const phi = rng.next() * Math.PI * 2, rho = 1 + rng.gauss() * o.a, h = rng.gauss() * o.h
    const x = o.R[0] * rho * Math.cos(phi), y0 = o.R[1] * rho * Math.sin(phi)
    const y = y0 * ct - h * st, z = y0 * st + h * ct
    fn([x * cp - y * sp, x * sp + y * cp, z], rho)
  }
}
// King-like cluster: rho ~ (1 + (r/rc)^2)^-1.5, softly truncated at rt; optional flattening
function king(rng, o, fn) {
  const N = 200, r = [], cdf = [0]
  for (let i = 0; i <= N; i++) r.push(o.rt * (i / N) ** 2)
  for (let i = 1; i <= N; i++) {
    const m = (r[i] + r[i - 1]) / 2, rho = (1 + (m / o.rc) ** 2) ** -1.5 * (1 - m / o.rt) ** 2
    cdf.push(cdf[i - 1] + rho * m * m * (r[i] - r[i - 1]))
  }
  const at = o.at || [0, 0, 0], fl = o.flat || 1
  for (let i = 0; i < o.n; i++) {
    const u = rng.next() * cdf[N]
    let k = 1
    while (cdf[k] < u) k++
    const rr = r[k - 1] + (r[k] - r[k - 1]) * rng.next(), d = rng.dir()
    fn(add(at, [d[0] * rr, d[1] * rr * fl, d[2] * rr]), rr)
  }
}

// ---- Star populations: [T, L] -------------------------------------------------------------------
const imf = (rng, m0, m1) => (m0 ** -1.35 + rng.next() * (m1 ** -1.35 - m0 ** -1.35)) ** (1 / -1.35)   // Salpeter
const dwarf = m => [5772 * m ** 0.55, Math.min(m ** 3.5, 3e5)]
const young = (rng, m0, m1) => dwarf(imf(rng, m0, m1))
// an old metal-poor globular population, as seen: the turnoff, giant branch, horizontal branch
function oldStar(rng) {
  const u = rng.next()
  if (u < 0.5) return [rng.range(5600, 6400), rng.range(0.8, 3.5)]
  if (u < 0.86) { const L = 10 ** (0.6 + 2.6 * rng.next() ** 2.2); return [5200 - 420 * Math.log10(L), L] }
  if (u < 0.97) return [rng.range(6000, 13000), rng.range(35, 60)]
  return [rng.range(7000, 8500), rng.range(4, 15)]                    // blue stragglers
}

// ---- The objects ----------------------------------------------------------------------------------
function orion(b, rng) {
  // the Huygens region: hot teal-white gas round the Trapezium, on the near face of the cloud
  cloud(rng, { r: [1.6, 1.3, 1], n: 260 }, p => b.gas(p, mixc(HOT, OIII, rng.next() * 0.7), 0.09, rng.range(0.25, 0.9)))
  const fall = p => Math.exp(-Math.hypot(p[0], p[1]) / 7)
  cloud(rng, { at: [0, -2, 1], r: [6, 5, 2.5], n: 1500, wisp: 0.6, scale: 2.5, seed: 1 }, p => b.gas(p, mixc(PINK, HA, rng.next()), 0.065 * fall(p), rng.range(0.35, 1.5)))
  // the two wings sweeping south
  path(rng, [[0.5, 0, 0], [5, -3, 1], [9, -9, 2], [8, -15, 2]], { n: 700, width: 1.6 }, p => b.gas(p, HA, 0.045 * fall(p) + 0.008, rng.range(0.4, 1.5)))
  path(rng, [[-0.5, 0, 0], [-6, -2, 1], [-10, -7, 2], [-11, -13, 2]], { n: 650, width: 1.6 }, p => b.gas(p, HA, 0.04 * fall(p) + 0.008, rng.range(0.4, 1.5)))
  // M43, cut off by the dark Fish's Mouth
  cloud(rng, { at: [-0.8, 4.5, 0.5], r: [1.3, 1.2, 1], n: 140 }, p => b.gas(p, PINK, 0.05, rng.range(0.3, 1)))
  path(rng, [[-5, 2.2, -1], [-1.5, 2.6, -1], [1.5, 2.3, -1], [3.5, 4, -0.5]], { n: 320, width: 0.7 }, p => b.dust(p, 0.4, rng.range(0.25, 0.8)))
  // Orion A, the molecular cloud the blister is carved into, behind
  cloud(rng, { at: [0, -3, 6], r: [14, 11, 2.5], n: 500, wisp: 0.4, scale: 5, seed: 2 }, p => b.dust(p, 0.35, rng.range(1.5, 4)))
  // the Trapezium (theta1 Ori C, A, B, D) and the Orion Nebula Cluster
  b.star([0.03, 0.05, 0.2], [39000, 2e5]); b.star([-0.08, 0.1, 0.25], [30000, 2.5e4])
  b.star([0.06, -0.08, 0.15], [20000, 3e3]); b.star([0.1, 0.12, 0.2], [32000, 3e4])
  king(rng, { rc: 0.6, rt: 12, n: 1500 }, p => b.star(p, young(rng, 0.3, 8)))
}

// Barnard 33's silhouette (ly; a chess knight facing east, neck rooted in the dark cloud)
const HORSE = [[0, -3.2], [1.4, -3.4], [1.9, -2.2], [2.3, -0.9], [2.5, 0.3], [2.3, 1.2], [2, 1.9], [1.75, 2.4], [1.5, 1.95], [1.2, 2.2], [1, 1.7],
  [0.4, 1.3], [-0.2, 0.7], [-0.6, 0.15], [-0.45, -0.25], [0.1, -0.2], [0.5, -0.6], [0.6, -1.4], [0.3, -2.3]].map(([x, y]) => [x * 0.8, y * 0.8])
function horsehead(b, rng) {
  // IC 434: a glowing sheet lit by sigma Orionis to the west, brightest at the dark cloud's edge
  cloud(rng, { at: [4, 0, 1.5], r: [4, 12, 0.8], n: 1800, wisp: 0.5, scale: 1.5, seed: 3 }, p => b.gas(p, HA, 0.09 * Math.exp(-Math.max(p[0], 0) / 4), rng.range(0.4, 1.3)))
  // L1630, the dark cloud filling the east, with a ragged edge
  const edge = y => -0.4 + 0.7 * Math.sin(y * 0.45) + 0.3 * Math.sin(y * 1.3)
  cloud(rng, { at: [-8, 0, -1], r: [6, 12, 0.6], n: 2200 }, p => { const s = rng.range(0.3, 1.5); if (p[0] < edge(p[1]) - s * 0.5) b.dust(p, 0.85, s) })
  for (let i = 0; i < 1600;) {
    const x = rng.range(-0.6, 2.1), y = rng.range(-2.8, 2)
    if (inside(HORSE, x, y)) { b.dust([x, y, -0.6 + rng.gauss() * 0.15], 0.9, rng.range(0.07, 0.15)); i++ }
  }
  // its western rim, lit by sigma Orionis
  for (const [k, q] of HORSE.entries()) {
    const r = HORSE[(k + 1) % HORSE.length]
    if (r[1] > q[1]) path(rng, [[q[0], q[1], -0.3], [r[0], r[1], -0.3]], { n: 30, width: 0.05 }, p => b.gas([p[0] + 0.08, p[1], p[2]], PINK, 0.08, rng.range(0.05, 0.12)))
  }
  // NGC 2023 (blue reflection round HD 37903) and the Flame Nebula by Alnitak
  cloud(rng, { at: [-3.5, -4.5, -1.5], r: [0.9, 0.9, 0.7], n: 100 }, p => b.gas(p, REFL, 0.04, rng.range(0.2, 0.7)))
  b.star([-3.5, -4.5, -1.5], [22000, 8000])
  cloud(rng, { at: [-6, 9, -1.5], r: [2.2, 2, 1.2], n: 260, wisp: 0.4, scale: 0.8, seed: 4 }, p => b.gas(p, [1, 0.55, 0.28], 0.06, rng.range(0.2, 0.7)))
  path(rng, [[-6.2, 6.5, -2.5], [-5.8, 9, -2.5], [-6.4, 11.5, -2.5]], { n: 80, width: 0.3 }, p => b.dust(p, 0.8, rng.range(0.2, 0.5)))
  b.star([11, 2, 2], [33000, 4e4])                                           // sigma Orionis
}

// a dark column eroding toward its lit tip, with a thin glowing skin on the lit side
function pillar(b, rng, base, top, w) {
  path(rng, [base, top], { n: Math.round(320 * w), width: w * 0.3, taper: 0.6 }, p => b.dust(p, 0.85, rng.range(0.12, 0.32) * w))
  path(rng, [base, top].map(q => [q[0] + 0.3 * w, q[1], q[2] - 0.3 * w]), { n: Math.round(100 * w), width: w * 0.12, taper: 0.5 }, p => b.gas(p, PINK, 0.03, rng.range(0.06, 0.14) * w))
  cloud(rng, { at: [top[0], top[1] + 0.15 * w, top[2] - 0.4 * w], r: [w * 0.3, w * 0.15, w * 0.2], n: 50 }, p => b.gas(p, mixc(PINK, HOT, 0.4), 0.15, rng.range(0.06, 0.18) * w))
  for (let i = 0; i < 4; i++) {                                               // knobbly side lumps
    const t = rng.range(0.1, 0.8), at = base.map((v, j) => v + (top[j] - v) * t + (j < 2 ? rng.gauss() * w * 0.3 : 0))
    cloud(rng, { at, r: [w * 0.25, w * 0.25, w * 0.2], n: 25 }, p => b.dust(p, 0.85, rng.range(0.1, 0.25) * w))
  }
}
function eagle(b, rng) {
  // a cavity open toward us: the shell's near cap is gone
  shell(rng, { R: [26, 22, 18], thick: 0.15, n: 1600, wisp: 0.6, scale: 5, seed: 5 }, p => { if (p[2] > -7) b.gas(p, HA, 0.01, rng.range(1.2, 4)) })
  cloud(rng, { r: [13, 12, 9], n: 500, wisp: 0.4, scale: 5, seed: 6 }, p => b.gas(p, mixc(HA, OIII, 0.35 + rng.next() * 0.35), 0.007, rng.range(1.5, 4)))
  // the bright heart round the pillars and the cluster, and dark lanes framing it
  cloud(rng, { at: [1, 1, 1], r: [9, 8, 4], n: 900, wisp: 0.5, scale: 2.5, seed: 21 }, p => b.gas(p, mixc(PINK, HA, rng.next()), 0.03, rng.range(0.6, 2)))
  for (const end of [[-24, 12, -4], [20, -16, -4]]) path(rng, [[-6, -14, -4], [0, -14, -4], end], { n: 500, width: 2.5 }, p => { if (wispy(rng, p, { wisp: 0.4, scale: 3, seed: 22 })) b.dust(p, 0.45, rng.range(0.8, 2.2)) })
  // the Pillars of Creation and the Spire, lit at their tips by NGC 6611
  for (const [base, top, w] of [[[-3.5, -9, -2], [-2.6, -2, -2], 1.7], [[-0.6, -8.5, -1.5], [0, -4, -1.5], 1.3], [[1.8, -8, -1.8], [2.3, -5, -1.8], 1], [[-15, 2, -1.5], [-11, 10, -1.5], 1.6]]) pillar(b, rng, base, top, w)
  cloud(rng, { at: [-12, -14, -3], r: [10, 6, 3], n: 320, wisp: 0.5, scale: 4, seed: 7 }, p => b.dust(p, 0.5, rng.range(0.8, 2.5)))
  king(rng, { at: [5, 6, -2], rc: 2, rt: 18, n: 600 }, p => b.star(p, young(rng, 0.8, 60)))
}

function lagoon(b, rng) {
  cloud(rng, { r: [40, 17, 14], n: 1800, wisp: 0.55, scale: 7, seed: 8 }, p => b.gas(p, mixc(PINK, HA, rng.next()), 0.045, rng.range(2, 6)))
  cloud(rng, { at: [12, 2, -2], r: [10, 7, 6], n: 900, wisp: 0.4, scale: 4, seed: 9 }, p => b.gas(p, PINK, 0.08, rng.range(1, 3.5)))
  cloud(rng, { at: [15, 0, -3], r: [1.2, 1.6, 1], n: 90 }, p => b.gas(p, HOT, 0.12, rng.range(0.2, 0.8)))                  // the Hourglass
  path(rng, [[-1, 18, -6], [3, 7, -6], [2, -3, -6], [-5, -15, -6]], { n: 900, width: 2.4 }, p => { if (wispy(rng, p, { wisp: 0.5, scale: 2, seed: 18 })) b.dust(p, 0.45, rng.range(0.7, 2)) })   // the lagoon itself
  king(rng, { at: [-14, -2, -4], rc: 3, rt: 20, n: 450 }, p => b.star(p, young(rng, 0.8, 30)))                         // NGC 6530
  b.star([15.3, 0.2, -3], [38000, 2e5])                                      // Herschel 36
  b.star([3, 8, -4], [43000, 6e5])                                           // 9 Sagittarii
}

function carina(b, rng) {
  cloud(rng, { r: [55, 42, 35], n: 2600, wisp: 0.6, scale: 12, seed: 10 }, p => b.gas(p, mixc(HA, PINK, rng.next()), 0.022, rng.range(3, 9)))
  cloud(rng, { r: [20, 17, 14], n: 900, wisp: 0.4, scale: 6, seed: 11 }, p => b.gas(p, mixc(PINK, OIII, rng.next() * 0.6), 0.035, rng.range(1.5, 4)))
  // the great V of dust, the Keyhole beside Eta Carinae, pillars on the inner rim
  for (const end of [[-48, 24, -12], [-32, -40, -12]]) path(rng, [[-4, -3, -12], end], { n: 900, width: 4.5 }, p => { if (wispy(rng, p, { wisp: 0.4, scale: 4, seed: 19 })) b.dust(p, 0.55, rng.range(1.5, 4.5)) })
  cloud(rng, { at: [1.5, -1, -2], r: [2, 1.6, 1], n: 70 }, p => b.dust(p, 0.85, rng.range(0.3, 0.8)))
  for (const [base, top, w] of [[[-30, -22, -4], [-24, -15, -4], 2.5], [[22, -24, -3], [17, -17, -3], 2], [[-8, 26, -3], [-6, 19, -3], 1.8]]) pillar(b, rng, base, top, w)
  king(rng, { rc: 4, rt: 25, n: 400 }, p => b.star(p, young(rng, 1, 60)))                                              // Trumpler 16
  king(rng, { at: [12, 14, -3], rc: 1.2, rt: 12, n: 350 }, p => b.star(p, young(rng, 1, 80)))                           // Trumpler 14
}

function rosette(b, rng) {
  // a thick ring more than a sphere: the caps facing us are thin, which leaves the famous hole
  shell(rng, { R: [38, 38, 38], thick: 0.2, n: 2600, wisp: 0.6, scale: 8, seed: 12 }, p => { if (Math.abs(p[2]) < 20) b.gas(p, mixc(HA, PINK, rng.next() * 0.4), 0.014, rng.range(2, 5.5)) })
  shell(rng, { R: [24, 24, 24], thick: 0.12, n: 500, wisp: 0.3, scale: 6, seed: 13 }, p => { if (Math.abs(p[2]) < 14) b.gas(p, mixc(OIII, PINK, 0.45), 0.006, rng.range(2, 5)) })
  for (let k = 0; k < 30; k++) {                                              // dark globules in the shell
    const d = rng.dir(), r = rng.range(24, 40)
    cloud(rng, { at: [d[0] * r, d[1] * r, d[2] * r * 0.5], r: [0.6, 0.6, 0.6], n: rng.int(5, 10) }, p => b.dust(p, 0.6, rng.range(0.3, 0.9)))
  }
  king(rng, { rc: 4, rt: 18, n: 300 }, p => b.star(p, young(rng, 1, 50)))                                               // NGC 2244
  b.star([2, -1, -1], [44000, 4e5]); b.star([-3, 2, 1], [41000, 2.5e5])     // HD 46223, HD 46150
}

// North America Nebula outline (it does look like the map: north up, the Gulf at lower right)
const NA = [[-35, 22], [-30, 28], [-15, 30], [0, 30], [12, 28], [20, 22], [28, 14], [24, 8], [20, 2], [18, -6], [17, -12], [19, -20], [14, -14],
  [8, -10], [0, -10], [-4, -18], [-2, -28], [-10, -22], [-16, -10], [-24, 0], [-28, 10], [-38, 16]]
const inside = (poly, x, y) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
function northAmerica(b, rng) {
  const wall = (x, y) => Math.exp(-(((x + 1) ** 2) / 30 + ((y + 16) ** 2) / 120))     // the Cygnus Wall, along "Mexico"
  for (let i = 0; i < 2600;) {
    const x = rng.range(-40, 30), y = rng.range(-30, 32), p = [x, y, rng.gauss() * 5]
    if (!inside(NA, x, y) || !wispy(rng, p, { wisp: 0.4, scale: 5, seed: 14 })) continue
    b.gas(p, mixc(HA, PINK, wall(x, y)), 0.018 + 0.07 * wall(x, y), rng.range(1, 3.5) * (1 - 0.6 * wall(x, y))); i++
  }
  // LDN 935: the dark cloud carving the Gulf and the Atlantic coast, in front of the glow
  for (let i = 0; i < 1100;) {
    const x = rng.range(4, 46), y = rng.range(-38, 16)
    const p = [x, y, rng.range(-6, -2)]
    if (inside(NA, x, y) || ((x - 55) / 13) ** 2 + ((y - 5) / 13) ** 2 < 1 || !wispy(rng, p, { wisp: 0.3, scale: 6, seed: 20 })) continue
    b.dust(p, 0.4, rng.range(1, 3)); i++
  }
  // the Pelican (IC 5070) and its bright ridge, and a faint halo round both
  cloud(rng, { at: [56, 5, 0], r: [12, 12, 6], n: 800, wisp: 0.5, scale: 4, seed: 15 }, p => b.gas(p, HA, 0.03, rng.range(0.8, 2.8)))
  path(rng, [[45, -7, -1], [48, 2, -1], [47, 11, -1]], { n: 240, width: 0.9 }, p => b.gas(p, PINK, 0.07, rng.range(0.3, 1)))
  cloud(rng, { at: [10, 0, 0], r: [55, 40, 15], n: 400 }, p => b.gas(p, HA, 0.008, rng.range(4, 9)))
}

function crab(b, rng) {
  const ax = [-0.819, -0.574, 0], pe = [0.574, -0.819, 0]                     // major axis at PA 125 deg
  const toSky = (u, v, w) => [u * ax[0] + v * pe[0], u * ax[1] + v * pe[1], w]
  for (let k = 0; k < 46; k++) {                                              // filaments: arcs on the expanding shell
    const a = rng.dir(), t0 = rng.dir(), len = rng.range(0.6, 2.2)
    const c = [a[1] * t0[2] - a[2] * t0[1], a[2] * t0[0] - a[0] * t0[2], a[0] * t0[1] - a[1] * t0[0]], cl = Math.hypot(...c)
    const v2 = [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]].map(x => x / cl)
    const col = rng.pick([SII, HA, [1, 0.72, 0.35]])
    for (let i = 0; i < 40; i++) {
      const th = rng.next() * len, s = 0.85 + 0.15 * rng.next()
      const d = [0, 1, 2].map(j => (Math.cos(th) * a[j] + Math.sin(th) * v2[j]) * s)
      b.gas(toSky(d[0] * 5.5, d[1] * 3.5, d[2] * 3.5), col, 0.12, rng.range(0.08, 0.22))
    }
  }
  cloud(rng, { r: [3, 2, 2], n: 350 }, p => b.gas(toSky(...p), SYNC, 0.03, rng.range(0.4, 1.2)))   // synchrotron glow
  b.star([0, 0, 0], [30000, 0.5])                                            // the Crab pulsar
}

function ring(b, rng) {
  const t = 0.18, pa = 1.0
  torus(rng, { R: [0.5, 0.36], a: 0.13, h: 0.3, tilt: t, pa, n: 1500 }, (p, rho) => b.gas(p, rho > 1.05 ? mixc(HA, PINK, 0.3) : mixc(OIII, HA, Math.max(0, (rho - 0.8) * 3)), 0.12, rng.range(0.03, 0.08)))
  cloud(rng, { r: [0.28, 0.22, 0.3], n: 260 }, p => b.gas(p, mixc(OIII, REFL, 0.3), 0.04, rng.range(0.06, 0.16)))
  shell(rng, { R: [1.1, 1, 1], thick: 0.15, n: 360, wisp: 0.5, scale: 0.3, seed: 16 }, p => b.gas(p, HA, 0.005, rng.range(0.08, 0.2)))
  b.star([0, 0, 0], [125000, 200])                                           // the central white dwarf
}

function helix(b, rng) {
  torus(rng, { R: [1.15, 1], a: 0.2, h: 0.35, tilt: 0.35, pa: 0.4, n: 1700 }, (p, rho) => b.gas(p, rho < 0.95 ? mixc(OIII, SII, Math.max(0, rho - 0.7) * 3) : HA, 0.07, rng.range(0.06, 0.16)))
  torus(rng, { R: [1.75, 1.6], a: 0.15, h: 0.3, tilt: 1.2, pa: -0.5, n: 900 }, p => b.gas(p, HA, 0.035, rng.range(0.08, 0.2)))
  cloud(rng, { r: [0.8, 0.7, 0.6], n: 450 }, p => b.gas(p, mixc(OIII, REFL, 0.4), 0.025, rng.range(0.12, 0.35)))
  // cometary knots: bright heads with dark tails pointing away from the star
  torus(rng, { R: [0.95, 0.83], a: 0.08, h: 0.2, tilt: 0.35, pa: 0.4, n: 300 }, p => {
    const l = Math.hypot(...p)
    b.gas(p, mixc(PINK, HOT, 0.4), 0.3, rng.range(0.004, 0.01))
    for (let i = 1; i <= 4; i++) b.dust(p.map(v => v * (1 + i * 0.012 / l)), 0.35, rng.range(0.005, 0.012))
  })
  b.star([0, 0, 0], [100000, 90])
}

function pleiades(b, rng) {
  // the bright B stars at their real places: RA (h), Dec (deg), L, T
  const named = [[3.79141, 24.10514, 2030, 12750], [3.81937, 24.05342, 940, 12000], [3.74793, 24.11333, 1225, 13400], [3.76378, 24.36775, 660, 12600],
    [3.7721, 23.94836, 630, 14000], [3.75347, 24.46728, 600, 13700], [3.81978, 24.13672, 190, 12000], [3.74673, 24.28947, 240, 13000], [3.76513, 24.5545, 140, 13000]]
  for (const [ra, dec, L, T] of named) {
    const p = b.sky(ra, dec, 444).map((v, i) => (i === 2 ? rng.gauss() * 1.5 : v))
    b.star(p, [T, L])
    // reflection haze: the cluster is drifting through an unrelated dust cloud, streaked by the starlight
    cloud(rng, { at: p, r: [1.4, 1.1, 1.2], n: L > 500 ? 150 : 40, wisp: 0.5, scale: 0.6, seed: 17 }, q => b.gas(q, REFL, 0.03, rng.range(0.15, 0.6)))
  }
  king(rng, { rc: 4, rt: 35, n: 900 }, p => b.star(p, young(rng, 0.6, 4.5)))
}

function hyades(b, rng) {
  // the four K giants and theta2 Tau: RA, Dec, L, T
  for (const [ra, dec, L, T] of [[4.32989, 15.6275, 99, 4844], [4.38224, 17.5425, 85, 4980], [4.47694, 19.1806, 97, 4900], [4.47625, 15.9622, 70, 4950], [4.47769, 15.8708, 69, 8000]])
    b.star(b.sky(ra, dec, 153).map((v, i) => (i === 2 ? rng.gauss() * 4 : v)), [T, L])
  king(rng, { rc: 9, rt: 33, n: 400 }, p => b.star(p, young(rng, 0.6, 2.4)))
}

function praesepe(b, rng) {
  for (let k = 0; k < 4; k++) b.star([rng.gauss() * 3, rng.gauss() * 3, rng.gauss() * 3], [rng.range(4750, 5000), rng.range(80, 115)])   // its four K giants
  king(rng, { rc: 5, rt: 35, n: 800 }, p => b.star(p, young(rng, 0.8, 2.3)))
}

function doubleCluster(b, rng) {
  for (const [ra, dec] of [[2.31667, 57.13333], [2.37333, 57.11667]]) {      // NGC 869 (h Per) and NGC 884 (chi Per)
    const at = b.sky(ra, dec, 7500)
    king(rng, { at, rc: 3, rt: 28, n: 2500 }, p => b.star(p, young(rng, 1, 14)))
    for (let k = 0; k < 12; k++) b.star(add(at, [rng.gauss() * 5, rng.gauss() * 5, rng.gauss() * 5]), [rng.range(12000, 22000), rng.range(1e4, 8e4)])   // B supergiants
    for (let k = 0; k < 3; k++) b.star(add(at, [rng.gauss() * 7, rng.gauss() * 7, rng.gauss() * 7]), [rng.range(3500, 3800), rng.range(3e4, 1.2e5)])  // red supergiants
  }
}

// globulars: tens of thousands of old stars plus an unresolved glow with the same profile
const globular = (rc, rt, n, L, flat = 1) => (b, rng) => {
  b.glowL = L                                                                 // integrated light, for when no single star is visible
  king(rng, { rc, rt, n, flat }, p => b.star(p, oldStar(rng)))
  king(rng, { rc, rt: rt * 0.7, n: 900, flat }, (p, r) => b.gas(p, GLOW, 0.03, Math.max(rc * 0.9, r * 0.4)))
}

// name, type, RA (h), Dec (deg), distance (ly), radius (ly), facts, builder
export const DEEP_SKY = [
  ['Orion Nebula (M42)', 'emission nebula', 5.58814, -5.39111, 1344, 16, [['catalogue', 'M42 · NGC 1976'], ['stars', 'Trapezium + ~2,800 young stars'], ['age', '~2 million years']], orion],
  ['Horsehead Nebula', 'dark nebula', 5.68306, -2.45833, 1375, 14, [['catalogue', 'Barnard 33, against IC 434'], ['head', '~3.5 ly tall']], horsehead],
  ['Eagle Nebula (M16)', 'emission nebula', 18.31333, -13.81667, 5700, 32, [['catalogue', 'M16 · NGC 6611'], ['pillars', 'Pillars of Creation, ~4 ly']], eagle],
  ['Lagoon Nebula (M8)', 'emission nebula', 18.06028, -24.38667, 4100, 50, [['catalogue', 'M8 · NGC 6523'], ['cluster', 'NGC 6530']], lagoon],
  ['Carina Nebula', 'emission nebula', 10.751, -59.6844, 7500, 75, [['catalogue', 'NGC 3372'], ['stars', 'Eta Carinae, Trumpler 14 and 16']], carina],
  ['Rosette Nebula', 'emission nebula', 6.5625, 4.99833, 5200, 50, [['catalogue', 'NGC 2237-9, 2246'], ['cluster', 'NGC 2244']], rosette],
  ['North America Nebula', 'emission nebula', 20.98808, 44.52889, 2200, 55, [['catalogue', 'NGC 7000 + Pelican (IC 5070)'], ['feature', 'the Cygnus Wall']], northAmerica],
  ['Crab Nebula (M1)', 'supernova remnant', 5.57554, 22.0145, 6500, 7, [['catalogue', 'M1 · NGC 1952'], ['supernova', 'seen in 1054 AD'], ['pulsar', '30 turns a second']], crab],
  ['Ring Nebula (M57)', 'planetary nebula', 18.89308, 33.02917, 2300, 1.4, [['catalogue', 'M57 · NGC 6720'], ['age', '~4,000 years']], ring],
  ['Helix Nebula', 'planetary nebula', 22.49404, -20.83711, 650, 2.6, [['catalogue', 'NGC 7293'], ['knots', '~20,000 cometary knots']], helix],
  ['Pleiades (M45)', 'open cluster', 3.79, 24.11667, 444, 16, [['catalogue', 'M45 · Seven Sisters'], ['age', '~100 million years'], ['members', '~1,000']], pleiades],
  ['Hyades', 'open cluster', 4.44833, 15.86667, 153, 22, [['catalogue', 'Melotte 25'], ['age', '~625 million years'], ['members', '~400']], hyades],
  ['Beehive Cluster (M44)', 'open cluster', 8.67333, 19.66667, 577, 20, [['catalogue', 'M44 · Praesepe'], ['age', '~600 million years'], ['members', '~1,000']], praesepe],
  ['Double Cluster', 'open clusters', 2.345, 57.125, 7500, 45, [['catalogue', 'NGC 869 + NGC 884'], ['age', '~14 million years']], doubleCluster],
  ['Omega Centauri', 'globular cluster', 13.44647, -47.47947, 17090, 140, [['catalogue', 'NGC 5139'], ['stars', '~10 million'], ['age', '~12 billion years']], globular(11.7, 230, 40000, 1e6, 0.85)],
  ['47 Tucanae', 'globular cluster', 0.40158, -72.08128, 14700, 100, [['catalogue', 'NGC 104'], ['stars', '~1 million'], ['age', '~13 billion years']], globular(1.6, 180, 30000, 5e5)],
  ['Hercules Cluster (M13)', 'globular cluster', 16.69479, 36.45986, 22200, 80, [['catalogue', 'M13 · NGC 6205'], ['stars', '~300,000'], ['age', '~11.7 billion years']], globular(4, 135, 25000, 3e5)],
  ['M22', 'globular cluster', 18.60665, -23.90475, 10600, 60, [['catalogue', 'NGC 6656'], ['stars', '~100,000'], ['age', '~12 billion years']], globular(4, 97, 25000, 2e5)],
].map(([name, type, ra, dec, ly, radius, facts, build]) => ({ name, type, ra, dec, ly, radius, facts, build }))
export const DEEP_SKY_NAMES = DEEP_SKY.map(d => d.name)

// Unit east / north / away vectors (galactic axes) for a direction on the sky.
function skyAxes(ra, dec) {
  const V = fromRaDec(ra, dec, 1), e = 1e-4
  const unit = (q) => { const d = q.map((v, i) => v - V[i]), l = Math.hypot(...d); return d.map(v => v / l) }
  return [unit(fromRaDec(ra + e / 15, dec, 1)), unit(fromRaDec(ra, dec + e, 1)), V]
}

// HII regions and young clusters strung along the arms, away from the solar neighbourhood.
function armField(b, rng) {
  const sun = [-MILKY_WAY.centerLy[0], 0, -MILKY_WAY.centerLy[2]]
  const spot = jitter => {
    for (;;) {
      const [R, th, sig] = armSample(MILKY_WAY, rng), r = R + rng.gauss() * sig * jitter
      const p = [r * Math.cos(th) - sun[0], r * Math.sin(th) - sun[1], rng.gauss() * 90 - sun[2]]
      if (Math.hypot(...p) > 2500) return p
    }
  }
  for (let k = 0; k < 260; k++) {
    const at = spot(0.4), s = 25 + 110 * rng.next() ** 2
    cloud(rng, { at, r: [s, s, s * 0.6], n: Math.round(18 + s * 0.35), wisp: 0.3, scale: s / 3, seed: k }, p => b.gas(p, mixc(HA, PINK, rng.next() * 0.6), 0.035, rng.range(0.12, 0.35) * s))
    for (let i = rng.int(2, 7); i > 0; i--) b.star(add(at, [rng.gauss() * s * 0.3, rng.gauss() * s * 0.3, rng.gauss() * s * 0.2]), dwarf(rng.range(12, 45)))
  }
  for (let k = 0; k < 180; k++) king(rng, { at: spot(1), rc: rng.range(3, 8), rt: rng.range(15, 30), n: rng.int(30, 80) }, p => b.star(p, young(rng, 1.5, 12)))
}

// ---- The renderable set ---------------------------------------------------------------------------
export class DeepSky {
  constructor(scene) {
    this.root = new THREE.Group()
    scene.add(this.root)
    this.list = DEEP_SKY.map(d => this.make(d))
    this.field = this.assemble({ name: 'arm field', posLy: [0, 0, 0], V: [0, 0, 1] }, new Builder(null), b => armField(b, new Rng(hash(77))))
    this.all = [...this.list, this.field]
  }

  make(d) {
    const posLy = fromRaDec(d.ra, d.dec, d.ly), axes = skyAxes(d.ra, d.dec)
    const o = { ...d, kind: 'deepsky', posLy, V: axes[2], sunward: axes[2].map(v => -v), keys: names(d.name) }
    const b = new Builder(axes)
    b.center = posLy
    return this.assemble(o, b, b => d.build(b, new Rng(hash(...[...d.name].map(c => c.charCodeAt(0))))))
  }

  assemble(o, b, build) {
    build(b)
    o.upos = UPos.meters(...o.posLy.map(v => v * LY))
    o.group = new THREE.Group()
    o.far = gasMesh(b.farB, true); o.gas = gasMesh(b.gasB, false); o.near = gasMesh(b.nearB, true); o.stars = starMesh(b.starB)
    // a distant cluster's summed light as one point, gone once you are close enough to see its stars
    if (b.glowL) {
      o.glow = starSprites(1, { gain: 100, hideNear: o.radius * 12 })
      upload(o.glow.geometry, { iPos: new Float32Array(3), iColor: new Float32Array(GLOW), iLum: new Float32Array([b.glowL]) }, 1)
    }
    o.parts = [o.far, o.gas, o.near, o.stars, o.glow].filter(Boolean)
    for (const s of o.parts) o.group.add(s.mesh)
    this.root.add(o.group)
    return o
  }

  // Camera-relative placement, back-to-front ordering (sprites skip the depth test), and dust drawn
  // in front of or behind the glow depending on which side of the object the camera is.
  place(cam) {
    const c = cam.meters().map(v => v / LY), mw = MILKY_WAY.centerLy
    const fade = 1 - THREE.MathUtils.smoothstep(Math.hypot(c[0] - mw[0], c[1] - mw[1], c[2] - mw[2]) / MILKY_WAY.R, 1.5, 3)
    this.root.visible = fade > 0.002
    if (!this.root.visible) return
    const rel = [0, 0, 0]
    for (const o of this.all) {
      o.upos.sub(cam, rel)
      o.group.position.set(rel[0] / LY, rel[1] / LY, rel[2] / LY)
      o.dist = Math.hypot(...rel) / LY
      o.earthSide = rel[0] * o.V[0] + rel[1] * o.V[1] + rel[2] * o.V[2] > 0
    }
    ;[...this.all].sort((a, b) => b.dist - a.dist).forEach((o, k) => {
      const base = 10 + k * 4
      if (o.far) o.far.mesh.renderOrder = o.earthSide ? base : base + 2
      if (o.gas) o.gas.mesh.renderOrder = base + 1
      if (o.near) o.near.mesh.renderOrder = o.earthSide ? base + 2 : base
      if (o.stars) o.stars.mesh.renderOrder = base + 3
      if (o.glow) o.glow.mesh.renderOrder = base + 3
      for (const s of o.parts) s.u.opacity.value = fade
    })
  }

  // the smallest named object the camera is inside (distances from the last place())
  around() { return this.root.visible ? this.list.filter(o => o.dist < o.radius).sort((a, b) => a.radius - b.radius)[0] : null }

  find(name) { const lc = name.toLowerCase(); return this.list.find(o => o.keys.includes(lc)) }
}

// "Orion Nebula (M42)" answers to its full name, "orion nebula" and "m42"
function names(name) {
  const m = name.match(/^(.*) \((.*)\)$/)
  return [name, ...(m ? [m[1], m[2]] : [])].map(s => s.toLowerCase())
}
