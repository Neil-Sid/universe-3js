// Landable surfaces for rocky planets and moons. Near a body its sphere is swapped for a cube-sphere
// quadtree: every leaf is one instance of a shared GRID x GRID patch, displaced on the GPU by the
// body's height field. Positions are camera-relative (patch centre minus camera in float64 on the
// CPU, small offsets on the GPU) so the ground holds still at 1 m. The same height field runs on the
// CPU (heightAt) for collision, altitude and flight speed.
//
// Height = continental relief (Earth: bump map, Moon: albedo, others: the planet shader's own fbm)
//        + one octave ladder of value noise (wavelength lam0 / 2^i) with ridges and erosion damping
//        + craters, one 3D lattice per octave.
// Octaves coarser than 256 m are evaluated on the unit direction; finer ones on a camera-relative,
// 256-periodic lattice whose per-octave offsets are reduced in float64 (uOff), so they stay exact.
import * as THREE from 'three/webgpu'
import {
  Fn, Loop, If, uniform, uniformArray, attribute, varyingProperty, positionGeometry, positionWorld, texture, textureLoad,
  vec2, vec3, vec4, mat3, float, int, uint, ivec2, normalize, dot, cross, max, min, mix, clamp, smoothstep, abs, sign, floor, ceil, fract,
  length, sqrt, pow, exp2, log2, dFdx, dFdy, atan, acos, select, reflect, mx_fractal_noise_float, mx_worley_noise_float, mx_noise_float, time,
} from 'three/tsl'
import { toLinear } from './looks.js'
import { map } from './materials.js'

const GRID = 64                 // quads per patch edge
const SPLIT = 2.1               // split while closer than SPLIT patch edges
const MAX_INST = 4096
const ON = 3.6, OFF = 4.0       // terrain replaces the sphere below ON radii (from the centre), back above OFF
const PREP = 14                 // start loading and compiling below this many radii
const DETAIL_N = 16             // camera-relative octaves: 128 m .. 2 mm
const LAM_MIN = 0.5             // finest wavelength in the geometry (m)
const V_RATIO = 60              // geometry keeps wavelengths above distance / V_RATIO
const EYE = 1.8                 // camera clearance above the ground (m)
const TAU = Math.PI * 2

// Real bodies that differ from the generic recipe. elev: where continental relief comes from.
const REAL = {
  Earth: { elev: 'earth', A0: 0.6, peak: 6, crater: 0, ridge: 0.8 },   // the map holds > 20 km; relief peaks below it
  Moon: { elev: 'moon', A0: 0.9, crater: 1, ridge: 0.15 },
  Mars: { A0: 1.1, crater: 0.55, ridge: 0.5 },
  Mercury: { A0: 0.8, crater: 1, ridge: 0.2 },
}

// ---- CPU mirror of the GPU noise ------------------------------------------------------------------
const K1 = 0x8da6b343, K2 = 0xd8163841, K3 = 0xcb1ab31f
function lowbias(h) {
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b)
  return (h ^ (h >>> 16)) >>> 0
}
const latc = (x, y, z) => (lowbias((Math.imul(x, K1) + Math.imul(y, K2) + Math.imul(z, K3)) >>> 0) >>> 8) * (2 / 16777216) - 1

// gradient noise with analytic gradient on a lattice wrapped by `wrap` (bit mask): [v, dx, dy, dz]
function cornerGrad(x, y, z) {
  const h = lowbias((Math.imul(x, K1) + Math.imul(y, K2) + Math.imul(z, K3)) >>> 0)
  return [(h & 1023) / 511.5 - 1, ((h >>> 10) & 1023) / 511.5 - 1, ((h >>> 20) & 1023) / 511.5 - 1]
}
function gnoised(x, y, z, wrap) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), f = [x - ix, y - iy, z - iz]
  const u = f.map(t => t * t * t * (t * (t * 6 - 15) + 10)), du = f.map(t => 30 * t * t * (t * (t - 2) + 1))
  const X = [ix & wrap, (ix + 1) & wrap], Y = [iy & wrap, (iy + 1) & wrap], Z = [iz & wrap, (iz + 1) & wrap]
  const G = [], V = []
  for (let k = 0; k < 8; k++) {
    const a = k & 1, b = (k >> 1) & 1, c = k >> 2, g = cornerGrad(X[a], Y[b], Z[c])
    G.push(g); V.push(g[0] * (f[0] - a) + g[1] * (f[1] - b) + g[2] * (f[2] - c))
  }
  const [va, vb, vc, vd, ve, vf, vg, vh] = V, [ga, gb, gc, gd, ge, gf, gg, gh] = G
  const k1 = va - vb - vc + vd, k2 = va - vc - ve + vg, k3 = va - vb - ve + vf, k4 = -va + vb + vc - vd + ve - vf - vg + vh
  const v = va + u[0] * (vb - va) + u[1] * (vc - va) + u[2] * (ve - va) + u[0] * u[1] * k1 + u[1] * u[2] * k2 + u[2] * u[0] * k3 + u[0] * u[1] * u[2] * k4
  const lin = [vb - va + u[1] * k1 + u[2] * k3 + u[1] * u[2] * k4, vc - va + u[2] * k2 + u[0] * k1 + u[2] * u[0] * k4, ve - va + u[0] * k3 + u[1] * k2 + u[0] * u[1] * k4]
  const d = [0, 1, 2].map(c => ga[c] + u[0] * (gb[c] - ga[c]) + u[1] * (gc[c] - ga[c]) + u[2] * (ge[c] - ga[c])
    + u[0] * u[1] * (ga[c] - gb[c] - gc[c] + gd[c]) + u[1] * u[2] * (ga[c] - gc[c] - ge[c] + gg[c]) + u[2] * u[0] * (ga[c] - gb[c] - ge[c] + gf[c])
    + u[0] * u[1] * u[2] * (-ga[c] + gb[c] + gc[c] - gd[c] + ge[c] - gf[c] - gg[c] + gh[c]) + du[c] * lin[c])
  return [v * 1.6, d[0] * 1.6, d[1] * 1.6, d[2] * 1.6]
}
// four fixed rotations decorrelate the coarse octaves' lattices (rows of 3x3 matrices)
function axisRot([x, y, z], an) {
  const l = Math.hypot(x, y, z), c = Math.cos(an), s = Math.sin(an), t = 1 - c
  x /= l; y /= l; z /= l
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c]
}
const ROTS = [axisRot([0, 0, 1], 0), axisRot([1, 2, 3], 0.9), axisRot([-2, 1, 1], 1.7), axisRot([1, -1, 2], 2.4)]

// MaterialX perlin noise and fbm, bit-exact with three's mx_fractal_noise_float
const rotl = (x, k) => (x << k) | (x >>> (32 - k))
function bjfinal(a, b, c) {
  c ^= b; c -= rotl(b, 14); a ^= c; a -= rotl(c, 11); b ^= a; b -= rotl(a, 25)
  c ^= b; c -= rotl(b, 16); a ^= c; a -= rotl(c, 4); b ^= a; b -= rotl(a, 14)
  c ^= b; c -= rotl(b, 24)
  return c >>> 0
}
const MX_SEED = 0xdeadbeef + (3 << 2) + 13
const mxHash = (x, y, z) => bjfinal(MX_SEED + x, MX_SEED + y, MX_SEED + z)
function mxGrad(h, x, y, z) {
  h &= 15
  const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z
  return (h & 1 ? -u : u) + (h & 2 ? -v : v)
}
const mxFade = t => t * t * t * (t * (t * 6 - 15) + 10)
function mxPerlin(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z)
  const fx = x - X, fy = y - Y, fz = z - Z, u = mxFade(fx), v = mxFade(fy), w = mxFade(fz)
  const g = (dx, dy, dz) => mxGrad(mxHash(X + dx, Y + dy, Z + dz), fx - dx, fy - dy, fz - dz)
  const s1 = 1 - u, t1 = 1 - v, r1 = 1 - w
  return 0.982 * (r1 * (t1 * (g(0, 0, 0) * s1 + g(1, 0, 0) * u) + v * (g(0, 1, 0) * s1 + g(1, 1, 0) * u))
    + w * (t1 * (g(0, 0, 1) * s1 + g(1, 0, 1) * u) + v * (g(0, 1, 1) * s1 + g(1, 1, 1) * u)))
}
function mxFbm(x, y, z, oct) {
  let r = 0, a = 1
  for (let i = 0; i < oct; i++) { r += a * mxPerlin(x, y, z); a *= 0.5; x *= 2; y *= 2; z *= 2 }
  return r
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const dsmooth = (a, b, x) => { const t = (x - a) / (b - a); return t <= 0 || t >= 1 ? 0 : 6 * t * (1 - t) / (b - a) }
const band = (lam, lim) => Math.min(1, Math.max(0, lam / lim - 1))
const mod = (x, m) => ((x % m) + m) % m

// ---- body profiles --------------------------------------------------------------------------------
export const landable = b => b && (b.type === 'planet' || b.type === 'moon') && b.look && b.look.mode === 0

function seedOf(name) { return [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) }

function profile(b) {
  if (b._terrain) return b._terrain
  const look = b.look, real = REAL[b.name] ?? {}, Rm = b.radius, R = Rm / 1000
  const nM = Math.max(1, Math.round(Math.log2(Rm / 256 / 6)) + 1)       // octaves on the unit direction
  const F0 = Rm / 256 / 2 ** (nM - 1)                                    // so octave nM has a 128 m wavelength
  const s = Math.min(2.5, Math.max(0.8, Math.sqrt(6371 / R)))            // small bodies keep taller relief
  const elev = real.elev ?? null, seed = seedOf(b.name)
  const sea = elev === 'earth' ? 0 : look.sea > 0 ? look.sea : -1
  return (b._terrain = {
    R, Rm, nM, nT: nM + DETAIL_N, F0, lam0: Rm / F0, elev, look,
    A0: Math.min((real.A0 ?? (look.atmo ? 0.5 : 0.9)) * s, 0.04 * R),          // tiny moons: relief stays a few % of R
    peak: real.peak ?? (look.atmo ? Math.max(0, Math.round(Math.log2(Rm / F0 / 30000))) : 0), gainUp: 0.35, gain: 0.62, gainD: 0.52, ero: 8,
    crater: real.crater ?? (look.atmo ? look.craters * 0.4 : Math.max(look.craters, 0.3)),
    ridge: real.ridge ?? (look.atmo ? 0.6 : 0.3),
    ocean: elev === 'earth' || sea > 0, sea, contA: Math.min(4 * s, 0.08 * R),
    off: [(seed % 97) * 1.31, (seed % 89) * 0.77, (seed % 83) * 1.13], freq: look.freq,
    maxLevel: Math.ceil(Math.log2((2 * Rm) / GRID / 0.25)),
    hMax: Math.min(4 * s + 3, 0.2 * R),
  })
}

// ---- elevation maps (Earth: bump R + land G, Moon: albedo brightness), shared by CPU and GPU ----
const sources = new Map()
async function pixels(url) {
  const blob = await (await fetch(url)).blob()
  const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  return { w: img.width, h: img.height, rgba: g.getImageData(0, 0, img.width, img.height).data }
}
function source(P) {
  if (!P.elev) return Promise.resolve(null)
  const url = P.elev === 'earth' ? P.look.maps.brc : P.look.maps.day
  if (!sources.has(url)) sources.set(url, pixels(url).then(({ w, h, rgba }) => {
    const ch = P.elev === 'earth' ? 2 : 1, data = new Uint8Array(w * h * ch)
    for (let i = 0; i < w * h; i++) {
      if (ch === 2) { data[i * 2] = rgba[i * 4]; data[i * 2 + 1] = rgba[i * 4 + 1] }
      else data[i] = Math.round((rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3)
    }
    const tex = new THREE.DataTexture(data, w, h, ch === 2 ? THREE.RGFormat : THREE.RedFormat, THREE.UnsignedByteType)
    tex.needsUpdate = true
    return { w, h, ch, data, tex }
  }))
  return sources.get(url)
}

// equirectangular texel coordinates of a body-frame direction (sphere geometry: +Y pole, u = 0.5 at +X)
function texel(src, x, y, z) {
  const phi = Math.atan2(z, -x)
  const u = mod(phi / TAU, 1), v = Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI    // v from the top row
  return [u * src.w, v * src.h]
}
// cubic B-spline of channel c with gradient in texels: [value, d/dx, d/dy] (0..1 per byte)
function bspline(src, c, tx, ty) {
  const t = [tx - 0.5, ty - 0.5], i = t.map(Math.floor), f = [t[0] - i[0], t[1] - i[1]]
  const W = f.map(s => [(1 - s) ** 3 / 6, (3 * s ** 3 - 6 * s * s + 4) / 6, (-3 * s ** 3 + 3 * s * s + 3 * s + 1) / 6, s ** 3 / 6])
  const D = f.map(s => [-((1 - s) ** 2) / 2, (3 * s * s - 4 * s) / 2, (-3 * s * s + 2 * s + 1) / 2, s * s / 2])
  let v = 0, dx = 0, dy = 0
  for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
    let x = i[0] + a - 1; x = x < 0 ? x + src.w : x >= src.w ? x - src.w : x
    const y = Math.min(src.h - 1, Math.max(0, i[1] + b - 1))
    const s = src.data[(y * src.w + x) * src.ch + c] / 255
    v += W[0][a] * W[1][b] * s; dx += D[0][a] * W[1][b] * s; dy += W[0][a] * D[1][b] * s
  }
  return [v, dx, dy]
}
// texel gradient -> gradient on the unit sphere (per unit of p)
function texGrad(src, x, y, z, gx, gy) {
  const rr = Math.max(x * x + z * z, 1e-8), sy = Math.sqrt(rr)
  const du = src.w / TAU / rr, dv = -src.h / Math.PI / sy
  return [gx * du * z, gy * dv, -gx * du * x]
}

// Continental relief: [cont km, ruggedness, ridged share, crater density, gradient of cont per unit p]
function macroCPU(P, src, p) {
  const [x, y, z] = p
  if (P.elev === 'earth' && src) {
    const [tx, ty] = texel(src, x, y, z), [e, ex, ey] = bspline(src, 0, tx, ty), [m] = bspline(src, 1, tx, ty)
    const land = smooth(0.5, 0.9, m), ep = Math.max(e, 1e-4)
    const cont = (m - 0.5) * 0.06 + 6 * ep ** 1.7 * land
    const k = 10.2 * ep ** 0.7 * land
    return [cont, (0.12 + 1.6 * smooth(0.03, 0.6, e)) * smooth(0.3, 0.6, m), 0.8 * smooth(0.15, 0.6, e), 0, texGrad(src, x, y, z, ex * k, ey * k)]
  }
  if (P.elev === 'moon' && src) {
    const [tx, ty] = texel(src, x, y, z), [l, lx, ly] = bspline(src, 0, tx, ty)
    const k = 3 * dsmooth(0.3, 0.62, l)
    return [(smooth(0.3, 0.62, l) - 0.7) * 3, 0.5 + 0.8 * smooth(0.4, 0.6, l), P.ridge, 0.3 + 0.7 * smooth(0.42, 0.56, l), texGrad(src, x, y, z, lx * k, ly * k)]
  }
  const e = mxFbm(x * P.freq + P.off[0], y * P.freq + P.off[1], z * P.freq + P.off[2], 6) * 0.5 + 0.5
  const wet = P.sea > 0 ? smooth(P.sea - 0.03, P.sea + 0.05, e) : 1
  return [(e - (P.sea > 0 ? P.sea : 0.5)) * P.contA, (0.5 + 1.1 * smooth(0.45, 0.75, e)) * wet, P.ridge * smooth(0.55, 0.8, e), wet, [0, 0, 0]]
}

// One crater per lattice cell at most. Its centre sits on the surface plane through the cell (normal n)
// and it shrinks to stay inside the cell, so no neighbour lookups are needed. It fades in by its own
// size against the band limit. Returns [h km, gradient per cell] or null.
function craterCPU(Q, wrap, n, salt, cellKm, dens, limHi) {
  const K = Q.map(Math.floor), Kc = K.map(k => k + 0.5)
  const h1 = lowbias((Math.imul(K[0] & wrap, K1) + Math.imul(K[1] & wrap, K2) + Math.imul(K[2] & wrap, K3) + salt) >>> 0)
  const h2 = lowbias(h1)
  if ((h1 & 65535) >= dens * 65536) return null
  const j1 = (h2 & 255) / 255 - 0.5, j2 = ((h2 >>> 8) & 255) / 255 - 0.5, sz = ((h2 >>> 16) & 255) / 255, age = (h2 >>> 24) / 255
  const o = (Q[0] - Kc[0]) * n[0] + (Q[1] - Kc[1]) * n[1] + (Q[2] - Kc[2]) * n[2]
  const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const t1 = normalize3(cross3(n, ax)), t2 = cross3(n, t1)
  const H = Kc.map((c, a) => c + n[a] * o + (t1[a] * j1 + t2[a] * j2) * 0.5)
  let room = 1
  for (let a = 0; a < 3; a++) room = Math.min(room, (0.5 - Math.abs(H[a] - Kc[a])) / Math.max(Math.sqrt(Math.max(1 - n[a] * n[a], 0)), 1e-3))
  const r = Math.min(0.05 + 0.17 * sz * sz, room / 1.6)
  const w = r > 0.02 ? band(r * cellKm * 500, limHi) : 0
  if (w <= 0) return null
  const t = Q.map((q, a) => q - H[a]), tn = t[0] * n[0] + t[1] * n[1] + t[2] * n[2]
  for (let a = 0; a < 3; a++) t[a] -= n[a] * tn
  const d = Math.hypot(...t), [f, df] = craterProfile(d / r, r * 2 * cellKm, age)
  const k = (df * w) / (Math.max(d, 1e-6) * r)
  return [f * w, t[0] * k, t[1] * k, t[2] * k]
}
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
// Bowl, rounded rim and ejecta apron; big craters get flat floors. x = distance / radius, D in km.
const RIM0 = 0.85, RIM1 = 1.15
function craterProfile(x, D, age) {
  const depth = Math.min(0.2 * D, 0.6 * D ** 0.35) * (0.3 + 0.7 * age), rim = depth * 0.3
  const bowl = xx => [(depth + rim) * xx * xx - depth, 2 * (depth + rim) * xx]
  const apron = xx => { const s = Math.min(1, Math.max(0, (1.6 - xx) / 0.6)); return [rim * s * s * s, (-3 * rim * s * s) / 0.6] }
  if (x < RIM0) {
    const [f, df] = bowl(x), fl = -depth * (1 - 0.25 * smooth(10, 30, D))
    return f > fl ? [f, df] : [fl, 0]
  }
  if (x >= RIM1) return apron(x)
  const L = RIM1 - RIM0, t = (x - RIM0) / L, [p0, d0] = bowl(RIM0), [p1, d1] = apron(RIM1), m0 = d0 * L, m1 = d1 * L
  const t2 = t * t, t3 = t2 * t
  return [(2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (3 * t2 - 2 * t3) * p1 + (t3 - t2) * m1,
    ((6 * t2 - 6 * t) * p0 + (3 * t2 - 4 * t + 1) * m0 + (6 * t - 6 * t2) * p1 + (3 * t2 - 2 * t) * m1) / L]
}

// lattice coordinate of octave i: the unit direction for coarse octaves, the 256-periodic
// camera-relative lattice for fine ones (here exact from the sea-level point Pm)
function octave(P, p, Pm, i) {
  const sc = 2 ** i, f = P.F0 * sc, lam = P.lam0 / sc, det = i >= P.nM
  return { f, lam, det, q: det ? Pm.map(v => mod(v / lam, 256)) : p.map(v => v * f) }
}

// The octave ladder: fbm with ridges and erosion damping, then craters; returns [h km, gradient per unit p]
function reliefCPU(P, p, limHi, g0, rug, ridge, cd) {
  const Pm = p.map(v => v * P.Rm), g = [0, 0, 0], ge = [...g0]
  let h = 0
  const i1 = Math.min(P.nT, Math.ceil(Math.log2(P.lam0 / limHi)))
  for (let i = 0; i < i1; i++) {
    const { f, lam, det, q } = octave(P, p, Pm, i), w = band(lam, limHi), M = ROTS[det ? 0 : i % 4]
    const qs = [0, 1, 2].map(r => M[r * 3] * q[0] + M[r * 3 + 1] * q[1] + M[r * 3 + 2] * q[2])
    const nz = gnoised(qs[0] + i * 1.731, qs[1] + i * 3.117, qs[2] + i * 2.309, det ? 255 : -1)
    const gq = [0, 1, 2].map(c => M[c] * nz[1] + M[3 + c] * nz[2] + M[6 + c] * nz[3])     // back through the rotation
    const gd = ge[0] * p[0] + ge[1] * p[1] + ge[2] * p[2]
    const slope2 = ((ge[0] - p[0] * gd) ** 2 + (ge[1] - p[1] * gd) ** 2 + (ge[2] - p[2] * gd) ** 2) / (P.R * P.R)
    const a = ampOf(P, i) * rug * w / (1 + P.ero * slope2)
    const sa = Math.sqrt(nz[0] * nz[0] + RIDGE_E2), sg = nz[0] / sa         // soft |n|: crests without creases
    const rd = ridge * Math.min(1, Math.max(0, (lam - 500) / 2500))            // ridges are a mountain-scale thing
    h += a * (nz[0] + rd * (0.6 - 1.2 * sa - nz[0]))
    for (let c = 0; c < 3; c++) { const gi = (gq[c] + rd * (-1.2 * sg * gq[c] - gq[c])) * a * f; g[c] += gi; ge[c] += gi }
  }
  const dens = P.crater * 0.9 * cd
  if (P.crater > 0) for (let i = 0; i < i1; i++) {
    const { f, lam, det, q } = octave(P, p, Pm, i)
    const Q = q.map((v, c) => v * 0.5 + SALT_C[c])
    const nC = det ? p : normalize3(Q.map((v, c) => (Math.floor(v) + 0.5 - SALT_C[c]) / (f * 0.5)))
    const cr = craterCPU(Q, det ? 127 : -1, nC, Math.imul(i, 7919) >>> 0, (lam * 2) / 1000, lam < 5000 ? P.crater * 0.9 : dens, limHi)
    if (cr) { h += cr[0]; for (let c = 0; c < 3; c++) g[c] += cr[c + 1] * f * 0.5 }
  }
  return [h, g]
}
const SALT_C = [5.3, 1.7, 9.1], RIDGE_E2 = 0.012
// octave amplitude (km): rises to the peak octave, then falls (gain, gentler gainD in the camera-relative octaves)
const ampOf = (P, i) => P.A0 * (i < P.peak ? P.gainUp ** (P.peak - i) : P.gain ** (Math.min(i, P.nM) - P.peak) * P.gainD ** Math.max(i - P.nM, 0))
const normalize3 = v => { const l = Math.hypot(...v); return v.map(c => c / l) }

// Ground height (km above the reference radius) at a body-frame unit direction.
export function heightAt(b, p, limHi = LAM_MIN) {
  const P = profile(b), src = P.src
  if (P.elev && !src) return 0
  const [cont, rug, ridge, cd, gc] = macroCPU(P, src, p)
  const h = cont + reliefCPU(P, p, limHi, gc, rug, ridge, cd)[0]
  return P.ocean ? Math.max(h, 0) : h
}

// ---- GPU height field -------------------------------------------------------------------------------
const tLowbias = Fn(([h0]) => {
  const h = uint(h0).toVar()
  h.assign(h.bitXor(h.shiftRight(uint(16))).mul(uint(0x7feb352d)))
  h.assign(h.bitXor(h.shiftRight(uint(15))).mul(uint(0x846ca68b)))
  return h.bitXor(h.shiftRight(uint(16)))
}).setLayout({ name: 'tLowbias', type: 'uint', inputs: [{ name: 'h0', type: 'uint' }] })

const tHash3 = (x, y, z) => tLowbias(x.mul(uint(K1)).add(y.mul(uint(K2))).add(z.mul(uint(K3))))
const tLat = (x, y, z) => float(tHash3(x, y, z).shiftRight(uint(8))).mul(2 / 16777216).sub(1)
const toU = v => uint(int(v))

const tGrad = (x, y, z) => {
  const h = tHash3(x, y, z).toVar()
  return vec3(float(h.bitAnd(uint(1023))), float(h.shiftRight(uint(10)).bitAnd(uint(1023))), float(h.shiftRight(uint(20)).bitAnd(uint(1023)))).div(511.5).sub(1)
}
const tNoise = Fn(([x, wrap]) => {
  const i = floor(x), f = x.sub(i)
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10))
  const du = f.mul(f).mul(30).mul(f.mul(f.sub(2)).add(1))
  const ix = toU(i.x), iy = toU(i.y), iz = toU(i.z), one = uint(1)
  const X = [ix.bitAnd(wrap), ix.add(one).bitAnd(wrap)], Y = [iy.bitAnd(wrap), iy.add(one).bitAnd(wrap)], Z = [iz.bitAnd(wrap), iz.add(one).bitAnd(wrap)]
  const G = [], V = []
  for (let k = 0; k < 8; k++) {
    const a = k & 1, b = (k >> 1) & 1, c = k >> 2, g = tGrad(X[a], Y[b], Z[c]).toVar()
    G.push(g); V.push(dot(g, f.sub(vec3(a, b, c))).toVar())
  }
  const [va, vb, vc, vd, ve, vf, vg, vh] = V, [ga, gb, gc, gd, ge, gf, gg, gh] = G
  const k1 = va.sub(vb).sub(vc).add(vd), k2 = va.sub(vc).sub(ve).add(vg), k3 = va.sub(vb).sub(ve).add(vf)
  const k4 = va.negate().add(vb).add(vc).sub(vd).add(ve).sub(vf).sub(vg).add(vh)
  const v = va.add(u.x.mul(vb.sub(va))).add(u.y.mul(vc.sub(va))).add(u.z.mul(ve.sub(va))).add(u.x.mul(u.y).mul(k1)).add(u.y.mul(u.z).mul(k2)).add(u.z.mul(u.x).mul(k3)).add(u.x.mul(u.y).mul(u.z).mul(k4))
  const lin = vec3(vb.sub(va).add(u.y.mul(k1)).add(u.z.mul(k3)).add(u.y.mul(u.z).mul(k4)),
    vc.sub(va).add(u.z.mul(k2)).add(u.x.mul(k1)).add(u.z.mul(u.x).mul(k4)),
    ve.sub(va).add(u.x.mul(k3)).add(u.y.mul(k2)).add(u.x.mul(u.y).mul(k4)))
  const d = ga.add(gb.sub(ga).mul(u.x)).add(gc.sub(ga).mul(u.y)).add(ge.sub(ga).mul(u.z))
    .add(ga.sub(gb).sub(gc).add(gd).mul(u.x.mul(u.y))).add(ga.sub(gc).sub(ge).add(gg).mul(u.y.mul(u.z))).add(ga.sub(gb).sub(ge).add(gf).mul(u.z.mul(u.x)))
    .add(ga.negate().add(gb).add(gc).sub(gd).add(ge).sub(gf).sub(gg).add(gh).mul(u.x.mul(u.y).mul(u.z))).add(du.mul(lin))
  return vec4(v, d).mul(1.6)
}).setLayout({ name: 'tNoise', type: 'vec4', inputs: [{ name: 'x', type: 'vec3' }, { name: 'wrap', type: 'uint' }] })

const tAmp = (U, fi) => U.A0.mul(select(fi.lessThan(U.peak), pow(U.gainUp, U.peak.sub(fi)),
  pow(U.gain, min(fi, float(U.nM)).sub(U.peak)).mul(pow(U.gainD, max(fi.sub(float(U.nM)), 0)))))
const ROT_N = ROTS.map(m => mat3(...m))                 // TSL mat3() of 9 scalars takes rows, like Matrix3.set()
const ROT_T = ROTS.map(m => mat3(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]))
const tBand = (lam, lim) => clamp(lam.div(lim).sub(1), 0, 1)

const tProfile = (x, D, age) => {
  const depth = min(D.mul(0.2), pow(D, 0.35).mul(0.6)).mul(age.mul(0.7).add(0.3)).toVar(), rim = depth.mul(0.3)
  const bowl = xx => [depth.add(rim).mul(xx).mul(xx).sub(depth), depth.add(rim).mul(xx).mul(2)]
  const apron = xx => { const s = clamp(float(1.6).sub(xx).div(0.6), 0, 1); return [rim.mul(s).mul(s).mul(s), rim.mul(s).mul(s).mul(-3 / 0.6)] }
  const [fb, db] = bowl(x), fl = depth.negate().mul(float(1).sub(smoothstep(10, 30, D).mul(0.25)))
  const [fa, da] = apron(x)
  const L = RIM1 - RIM0, t = clamp(x.sub(RIM0).div(L), 0, 1), t2 = t.mul(t), t3 = t2.mul(t)
  const [p0, d0] = bowl(float(RIM0)), [p1, d1] = apron(float(RIM1)), m0 = d0.mul(L), m1 = d1.mul(L)
  const fh = t3.mul(2).sub(t2.mul(3)).add(1).mul(p0).add(t3.sub(t2.mul(2)).add(t).mul(m0)).add(t2.mul(3).sub(t3.mul(2)).mul(p1)).add(t3.sub(t2).mul(m1))
  const dh = t2.mul(6).sub(t.mul(6)).mul(p0).add(t2.mul(3).sub(t.mul(4)).add(1).mul(m0)).add(t.mul(6).sub(t2.mul(6)).mul(p1)).add(t2.mul(3).sub(t.mul(2)).mul(m1)).div(L)
  const inBowl = x.lessThan(RIM0), onRim = x.lessThan(RIM1)
  const f = select(inBowl, max(fb, fl), select(onRim, fh, fa))
  const df = select(inBowl, select(fb.greaterThan(fl), db, float(0)), select(onRim, dh, da))
  return [f, df]
}

const tCrater = Fn(([Q, wrap, n, salt, cellKm, dens, limLo, limHi]) => {
  const K = floor(Q), Kc = K.add(0.5)
  const h1 = tLowbias(toU(K.x).bitAnd(wrap).mul(uint(K1)).add(toU(K.y).bitAnd(wrap).mul(uint(K2))).add(toU(K.z).bitAnd(wrap).mul(uint(K3))).add(salt)).toVar()
  const h2 = tLowbias(h1).toVar()
  const present = float(h1.bitAnd(uint(65535))).lessThan(dens.mul(65536))
  const byte = k => float(h2.shiftRight(uint(k)).bitAnd(uint(255))).div(255)
  const j1 = byte(0).sub(0.5), j2 = byte(8).sub(0.5), sz = byte(16), age = byte(24)
  const o = dot(Q.sub(Kc), n)
  const t1 = normalize(cross(n, select(abs(n.x).lessThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0)))), t2 = cross(n, t1)
  const H = Kc.add(n.mul(o)).add(t1.mul(j1).add(t2.mul(j2)).mul(0.5))
  const room3 = float(0.5).sub(abs(H.sub(Kc))).div(max(sqrt(max(float(1).sub(n.mul(n)), 0)), 1e-3))
  const r = min(sz.mul(sz).mul(0.17).add(0.05), min(room3.x, min(room3.y, room3.z)).div(1.6))
  const rw = r.mul(cellKm).mul(500), w = tBand(rw, limHi).mul(float(1).sub(tBand(rw, limLo))).mul(select(r.greaterThan(0.02), float(1), float(0)))
  const t0 = Q.sub(H), t = t0.sub(n.mul(dot(t0, n))), d = length(t)
  const [f, df] = tProfile(d.div(r), r.mul(2).mul(cellKm), age)
  return select(present.and(w.greaterThan(0)), vec4(f, t.mul(df.div(max(d, 1e-6).mul(r)))).mul(w), vec4(0))
}).setLayout({ name: 'tCrater', type: 'vec4', inputs: [
  { name: 'Q', type: 'vec3' }, { name: 'wrap', type: 'uint' }, { name: 'n', type: 'vec3' }, { name: 'salt', type: 'uint' },
  { name: 'cellKm', type: 'float' }, { name: 'dens', type: 'float' }, { name: 'limLo', type: 'float' }, { name: 'limHi', type: 'float' }] })

// The octave ladder between the band limits limLo..limHi (m); g0 seeds the erosion state.
function reliefNode(U) {
  const octave = (p, relM, i) => {
    const fi = float(i), sc = exp2(fi), det = i.greaterThanEqual(U.nM), f = U.F0.mul(sc), lam = U.lam0.div(sc)
    return { fi, f, lam, det, q: select(det, U.off.element(max(i.sub(U.nM), int(0))).add(relM.div(lam)), p.mul(f)).toVar() }
  }
  return (p, relM, limLo, limHi, g0, rug, ridge, cd) => {
    const h = float(0).toVar(), g = vec3(0).toVar(), ge = vec3(g0).toVar()
    const top = log2(U.lam0.div(limLo.mul(2)))
    const i1 = int(min(ceil(log2(U.lam0.div(limHi))), float(U.nT)))
    Loop({ start: int(max(floor(top), 0)), end: i1, type: 'int', condition: '<' }, ({ i }) => {
      const { fi, f, lam, det, q } = octave(p, relM, i)
      const w = tBand(lam, limHi).mul(float(1).sub(tBand(lam, limLo)))
      const r = select(det, int(0), i.sub(i.div(4).mul(4)))
      const pick = f3 => select(r.equal(int(0)), f3(0), select(r.equal(int(1)), f3(1), select(r.equal(int(2)), f3(2), f3(3))))
      const nz = tNoise(pick(k => ROT_N[k].mul(q)).add(vec3(fi.mul(1.731), fi.mul(3.117), fi.mul(2.309))), select(det, uint(255), uint(0xffffffff))).toVar()
      const gq = pick(k => ROT_T[k].mul(nz.yzw))                              // back through the rotation
      const gt = ge.sub(p.mul(dot(ge, p)))
      const a = tAmp(U, fi).mul(rug).mul(w).div(dot(gt, gt).div(U.R.mul(U.R)).mul(U.ero).add(1))
      const sa = sqrt(nz.x.mul(nz.x).add(RIDGE_E2)), rd = ridge.mul(clamp(lam.sub(500).div(2500), 0, 1))
      const gi = gq.add(rd.mul(gq.mul(nz.x.div(sa).mul(-1.2)).sub(gq))).mul(a.mul(f))
      h.addAssign(a.mul(nz.x.add(rd.mul(float(0.6).sub(sa.mul(1.2)).sub(nz.x)))))
      g.addAssign(gi); ge.addAssign(gi)
    })
    // craters reach 4 octaves further: a crater is several times smaller than its cell
    const dens = U.crater.mul(0.9).mul(cd)
    Loop({ start: int(max(floor(top).sub(4), 0)), end: select(U.crater.greaterThan(0), i1, int(0)), type: 'int', condition: '<' }, ({ i }) => {
      const { f, lam, det, q } = octave(p, relM, i)
      const Q = q.mul(0.5).add(vec3(...SALT_C))
      const nC = select(det, p, normalize(floor(Q).add(0.5).sub(vec3(...SALT_C)).div(f.mul(0.5))))
      const cr = tCrater(Q, select(det, uint(127), uint(0xffffffff)), nC, uint(i).mul(uint(7919)), lam.mul(2 / 1000), select(lam.lessThan(5000), U.crater.mul(0.9), dens), limLo, limHi)
      h.addAssign(cr.x); g.addAssign(cr.yzw.mul(f.mul(0.5)))
    })
    return vec4(h, g)
  }
}

// equirect uv (v from the top row, as stored) and the texel-gradient -> unit-sphere-gradient map
const tUV = p => vec2(fract(atan(p.z, p.x.negate()).div(TAU)), acos(clamp(p.y, -1, 1)).div(Math.PI))
const tTexGrad = (p, w, h, gx, gy) => {
  const rr = max(p.x.mul(p.x).add(p.z.mul(p.z)), 1e-8)
  const du = gx.mul(w / TAU).div(rr), dv = gy.mul(-h / Math.PI).div(sqrt(rr))
  return vec3(du.mul(p.z), dv, du.mul(p.x).negate())
}
// 16-tap cubic B-spline from a DataTexture with exact float weights: value (vec4) and channel-0 gradient
function tBspline(src, p) {
  const t = tUV(p).mul(vec2(src.w, src.h)).sub(0.5), i = floor(t), f = t.sub(i)
  const wts = s => [float(1).sub(s).pow(3).div(6), s.pow(3).mul(3).sub(s.mul(s).mul(6)).add(4).div(6), s.pow(3).mul(-3).add(s.mul(s).mul(3)).add(s.mul(3)).add(1).div(6), s.pow(3).div(6)]
  const der = s => [float(1).sub(s).pow(2).mul(-0.5), s.mul(s).mul(3).sub(s.mul(4)).mul(0.5), s.mul(s).mul(-3).add(s.mul(2)).add(1).mul(0.5), s.mul(s).mul(0.5)]
  const wx = wts(f.x), wy = wts(f.y), dx = der(f.x)
  const dyw = der(f.y)
  const ix = int(i.x), iy = int(i.y)
  let v = vec4(0), gx = float(0), gy = float(0)
  for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
    const x0 = ix.add(a - 1), x = select(x0.lessThan(0), x0.add(src.w), select(x0.greaterThanEqual(src.w), x0.sub(src.w), x0))
    const y = clamp(iy.add(b - 1), int(0), int(src.h - 1))
    const s = textureLoad(src.tex, ivec2(x, y))
    v = v.add(s.mul(wx[a].mul(wy[b]))); gx = gx.add(s.x.mul(dx[a].mul(wy[b]))); gy = gy.add(s.x.mul(wx[a].mul(dyw[b])))
  }
  return { v, grad: tTexGrad(p, src.w, src.h, gx, gy) }
}

// Continental relief on the GPU: { cont, rug, ridge, gc } mirroring macroCPU
function tMacro(P, U, p) {
  if (P.elev === 'earth') {
    const { v, grad } = tBspline(P.src, p)
    const e = max(v.x, 1e-4), m = v.y, land = smoothstep(0.5, 0.9, m)
    const cont = m.sub(0.5).mul(0.06).add(pow(e, 1.7).mul(6).mul(land))
    return { cont, rug: smoothstep(0.03, 0.6, v.x).mul(1.6).add(0.12).mul(smoothstep(0.3, 0.6, m)), ridge: smoothstep(0.15, 0.6, v.x).mul(0.8), cd: float(0), gc: grad.mul(pow(e, 0.7).mul(10.2).mul(land)) }
  }
  if (P.elev === 'moon') {
    const { v, grad } = tBspline(P.src, p)
    const l = v.x, t = clamp(l.sub(0.3).div(0.32), 0, 1)
    return { cont: smoothstep(0.3, 0.62, l).sub(0.7).mul(3), rug: smoothstep(0.4, 0.6, l).mul(0.8).add(0.5), ridge: float(P.ridge), cd: smoothstep(0.42, 0.56, l).mul(0.7).add(0.3), gc: grad.mul(t.mul(float(1).sub(t)).mul(6 / 0.32).mul(3)) }
  }
  const e = mx_fractal_noise_float(p.mul(P.freq).add(vec3(...P.off)), 6, 2, 0.5).mul(0.5).add(0.5)
  const wet = P.sea > 0 ? smoothstep(P.sea - 0.03, P.sea + 0.05, e) : float(1)
  return { cont: e.sub(P.sea > 0 ? P.sea : 0.5).mul(P.contA), rug: smoothstep(0.45, 0.75, e).mul(1.1).add(0.5).mul(wet), ridge: smoothstep(0.55, 0.8, e).mul(P.ridge), cd: wet, gc: vec3(0) }
}

// ---- material ---------------------------------------------------------------------------------------
const FACES = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
]
const v3 = c => vec3(...toLinear(c))

function terrainMaterial(b, P) {
  const U = {
    R: uniform(P.R), F0: uniform(P.F0), lam0: uniform(P.lam0), nM: uniform(P.nM, 'int'), nT: P.nT,
    A0: uniform(P.A0), gain: uniform(P.gain), gainD: uniform(P.gainD), gainUp: uniform(P.gainUp), peak: uniform(P.peak), ero: uniform(P.ero), crater: uniform(P.crater),
    off: uniformArray(Array.from({ length: DETAIL_N }, () => new THREE.Vector3()), 'vec3'),
    rot: uniform(new THREE.Matrix3()), relief: uniform(0), pix: uniform(0.001), cloud: uniform(1), debug: uniform(0), texW: uniform(1024),
  }
  const FU = uniformArray(FACES.map(f => new THREE.Vector3(...f[1])), 'vec3'), FV = uniformArray(FACES.map(f => new THREE.Vector3(...f[2])), 'vec3')
  const relief = reliefNode(U)
  const vDir = varyingProperty('vec3', 'tDir'), vSea = varyingProperty('vec3', 'tSea'), vLocal = varyingProperty('vec3', 'tLocal')
  const vG = varyingProperty('vec3', 'tGrad'), vInfo = varyingProperty('vec4', 'tInfo')     // h, rug, ridge, crater density
  const mat = new THREE.MeshBasicNodeMaterial()

  mat.positionNode = Fn(() => {
    const pos = positionGeometry, cube = attribute('iCube', 'vec4'), rel = attribute('iRel', 'vec4')
    const face = int(rel.w.add(0.5)), cC = cube.xyz
    const d = pos.xy.sub(0.5).mul(cube.w)
    const delta = FU.element(face).mul(d.x).add(FV.element(face).mul(d.y))
    // normalize(cC + delta) - normalize(cC), written so no large numbers cancel
    const lenC = length(cC), k = dot(cC, delta).mul(2).add(dot(delta, delta)), lenP = sqrt(lenC.mul(lenC).add(k))
    const diff = delta.div(lenP).sub(cC.mul(k.div(lenP.mul(lenC).mul(lenP.add(lenC)))))
    const dir = cC.div(lenC).add(diff).toVar()
    const sea = diff.mul(U.R).add(rel.xyz).toVar()                // sea-level point minus camera, km, body frame
    const M = tMacro(P, U, dir)
    const r = relief(dir, sea.mul(1000), float(1e30), max(length(sea).mul(1000 / V_RATIO), LAM_MIN), M.gc, M.rug, M.ridge, M.cd)
    const raw = M.cont.add(r.x)
    const h = (P.ocean ? max(raw, 0) : raw).toVar()
    const g = select(raw.lessThan(0).and(P.ocean), vec3(0), M.gc.add(r.yzw))
    If(pos.z.greaterThan(0.5), () => { h.subAssign(cube.w.mul(U.R).div(lenC).mul(0.03).add(0.002)) })   // skirt
    const local = sea.add(dir.mul(h))
    vDir.assign(dir); vSea.assign(sea); vLocal.assign(local); vG.assign(g)
    vInfo.assign(vec4(raw, M.rug, M.ridge, M.cd))
    return U.rot.mul(local)
  })()

  const look = P.look
  mat.colorNode = Fn(() => {
    const p = normalize(vDir), distM = length(vLocal).mul(1000).max(1e-3)
    const water = P.ocean ? vInfo.x.lessThan(0) : vInfo.x.lessThan(-1e9)    // sea: the interpolated raw height crosses 0 at the shore
    // fine relief between the geometry's band limit and the pixel footprint, for normals only
    const fine = vec4(0).toVar()
    If(water.not(), () => { fine.assign(relief(p, vSea.mul(1000), max(distM.div(V_RATIO), LAM_MIN), max(distM.mul(U.pix).mul(2), 0.002), vG, vInfo.y, vInfo.z, vInfo.w)) })
    const g = vG.add(fine.yzw), gt = g.sub(p.mul(dot(g, p)))
    const Nb = normalize(mix(p, normalize(p.sub(gt.div(U.R))), U.relief))
    const N = normalize(U.rot.mul(Nb)), Ps = normalize(U.rot.mul(p))
    const L = normalize(b.u.sun), V = normalize(positionWorld).negate()
    const ndl = dot(N, L), ndlS = dot(Ps, L)
    const slope = float(1).sub(dot(Nb, p))
    const { albedo, wet, glow, gain, amb } = surfaceColor(P, U, p, fine.x, slope, water, distM, vInfo.x)
    const daylight = smoothstep(-0.08, 0.35, ndlS)
    const ambient = mix(float(amb[0]), float(amb[1]), U.relief)
    // airless regolith scatters like Lommel-Seeliger (flat-looking at low phase); blended in with the relief
    const mu0 = max(ndl, 0), mu = max(dot(N, V), 0.05)
    const brdf = look.atmo ? mu0 : mix(mu0, mu0.mul(1.5).div(mu0.add(mu)), U.relief.mul(0.5))
    const diffuse = daylight.mul(brdf.mul(float(1).sub(ambient)).add(ambient))
    const glint = pow(max(dot(reflect(L.negate(), N), V), 0), 60).mul(wet).mul(0.8).mul(max(ndl, 0))
    const lit = albedo.mul(diffuse).mul(gain).add(glint).mul(b.u.sunCol).mul(b.u.light)
    const out = lit.add(albedo.mul(0.003)).add(glow(ndlS))
    // debug views (U.debug): 1 = body-frame normal, 2 = albedo
    return vec4(select(U.debug.equal(1), Nb.mul(0.5).add(0.5), select(U.debug.equal(2), albedo, out)), 1)
  })()
  if (b.air) mat.colorNode = b.air.surface(mat.colorNode)    // aerial perspective + reddened sunlight (atmosphere.js)
  return { mat, U }
}

// Albedo near and far. Mapped bodies read their day map at the footprint's mip level; procedural ones
// repeat materials.js planetMaterial (mode 0) so the switch from the sphere is seamless.
function surfaceColor(P, U, p, hFine, slope, water, distM, hRaw) {
  const look = P.look
  const footKm = distM.mul(U.pix).div(1000)
  // fine relief and steep ground vary the colour up close (the maps are ~10 km per texel)
  const grain = clamp(hFine.mul(1000).div(max(distM.mul(U.pix).mul(30), 0.05)), -1, 1).mul(0.06).add(1)
  if (look.maps) {
    const day = map(look.maps.day, true, true)
    // mip level from the screen-space footprint of the direction (grazing views alias otherwise)
    const lod = log2(max(max(length(dFdx(p)), length(dFdy(p))).mul(U.texW.div(TAU)), 1e-4)).sub(0.5)
    const uv = tUV(p), tuv = vec2(uv.x.add((look.lon0 ?? 0.5) - 0.5), float(1).sub(uv.y))   // lon0: the map's own longitude origin
    const raw = texture(day, tuv).level(lod).rgb
    // the map corrections materials.js applies (sat, gain), so the switch from the sphere is seamless
    let albedo = (look.sat == null ? raw : mix(vec3(dot(raw, vec3(0.2126, 0.7152, 0.0722))), raw, look.sat)).mul(look.gain ?? 1).toVar()
    const brc = look.maps.brc ? texture(map(look.maps.brc, false, true), tuv).level(lod) : null
    let wet = float(0)
    if (brc) {
      const clouds = smoothstep(0.2, 1, brc.b).mul(U.cloud)
      wet = select(water, float(1), float(0)).mul(float(1).sub(clouds))
      // land the texture calls sea (the fractal coast runs past the 10 km map): beach and lowland colours
      albedo.assign(select(water.not().and(brc.g.lessThan(0.5)), mix(vec3(0.09, 0.085, 0.06), vec3(0.04, 0.055, 0.03), smoothstep(0.002, 0.015, hRaw)), albedo))
      // up close the map's 10 km snow texels give way to snow above the snowline and rock below / on cliffs
      const near = smoothstep(2, 0.2, footKm)
      const snowy = smoothstep(0.45, 0.65, dot(albedo, vec3(1 / 3))).mul(smoothstep(0.15, 0.05, max(albedo.r, max(albedo.g, albedo.b)).sub(min(albedo.r, min(albedo.g, albedo.b)))))
      const snowline = mix(float(4.8), float(0.3), smoothstep(0.3, 0.95, abs(p.y)))
      const snowNow = smoothstep(snowline.sub(0.4), snowline.add(0.3), hRaw).mul(smoothstep(0.3, 0.15, slope))
      const rockC = vec3(0.13, 0.12, 0.105)
      albedo.assign(mix(albedo, mix(rockC, vec3(0.8, 0.83, 0.88), snowNow), snowy.mul(near)))
      albedo.assign(mix(albedo, rockC, smoothstep(0.15, 0.3, slope).mul(near).mul(float(1).sub(snowNow.mul(snowy)))))
      albedo.assign(mix(albedo, vec3(1), clamp(clouds.mul(2), 0, 1)))
    }
    albedo.assign(albedo.mul(grain))
    const night = look.maps.night ? map(look.maps.night, true, true) : null
    const glow = ndl => night ? texture(night, tuv).level(lod).rgb.mul(smoothstep(0.1, -0.15, ndl)).mul(1.4) : vec3(0)
    return { albedo, wet, glow, gain: 2.2, amb: [0.2, look.atmo ? 0.1 : 0.02] }
  }
  // procedural (copy of materials.js mode 0; keep in sync)
  const off = vec3(...P.off), [c0, c1, c2, c3] = look.cols.map(v3)
  const h = mx_fractal_noise_float(p.mul(look.freq).add(off), 6, 2, 0.5).mul(0.5).add(0.5).toVar()
  const albedo = mix(mix(c0, c1, smoothstep(0.3, 0.5, h)), mix(c2, c3, smoothstep(0.62, 0.8, h)), smoothstep(0.45, 0.65, h)).toVar()
  if (look.craters) {
    const w = mx_worley_noise_float(p.mul(7).add(off)), w2 = mx_worley_noise_float(p.mul(19).add(off))
    const crater = smoothstep(0.05, 0.25, w).mul(0.35).add(0.65).mul(smoothstep(0.02, 0.12, w2).mul(0.25).add(0.75))
    albedo.mulAssign(mix(float(1), crater, look.craters))
  }
  const sea = select(water, float(1), float(0)).toVar()
  if (look.sea > 0) {
    albedo.assign(mix(albedo, v3(look.seaCol).mul(smoothstep(look.sea - 0.2, look.sea, h).mul(0.8).add(0.5)), sea))
    albedo.assign(select(water.not().and(h.lessThan(look.sea)), c1, albedo))
  }
  if (look.cap) {
    const cap = smoothstep(look.cap, look.cap + 0.04, abs(p.y).add(h.sub(0.5).mul(0.25)))
    albedo.assign(mix(albedo, vec3(0.74, 0.77, 0.82), cap)); sea.mulAssign(float(1).sub(cap))
  }
  if (look.cracks) {
    const k1 = abs(mx_noise_float(p.mul(look.freq * 1.3).add(off))), k2 = abs(mx_noise_float(p.mul(look.freq * 3.7).add(off.mul(2))))
    const lines = max(smoothstep(0.07, 0.0, k1), smoothstep(0.045, 0.0, k2).mul(0.7))
    albedo.assign(mix(albedo, vec3(0.2, 0.08, 0.03), lines.mul(look.cracks * 0.85)))
  }
  if (look.clouds) {
    const cl = mx_fractal_noise_float(p.mul(3.2).add(off.mul(2)).add(vec3(time.mul(0.002), 0, 0)), 5, 2, 0.55).mul(0.5).add(0.5)
    albedo.assign(mix(albedo, vec3(0.82), smoothstep(1 - look.clouds * 0.55, 1.05 - look.clouds * 0.4, cl).mul(U.cloud)))
  }
  albedo.assign(albedo.mul(grain))
  const lava = look.lava ? vec3(1.8, 0.5, 0.1).mul(smoothstep(0.52, 0.6, mx_noise_float(p.mul(12).add(off)).mul(0.5).add(0.5))).mul(look.lava * 3) : vec3(0)
  return { albedo, wet: sea, glow: () => lava, gain: 1.7, amb: [0.25, look.atmo ? 0.1 : 0.02] }
}

// ---- quadtree --------------------------------------------------------------------------------------
class Node {
  constructor(face, u, v, size, level, R) {
    const [F, Uu, Vv] = FACES[face]
    this.face = face; this.u = u; this.v = v; this.size = size; this.level = level; this.R = R
    this.cube = F.map((f, i) => f + u * Uu[i] + v * Vv[i])
    const len = Math.hypot(...this.cube)
    this.dir = this.cube.map(c => c / len)
    this.edge = (size * R) / len                                       // approximate edge length (km)
    this.children = null
  }
  split() {
    const h = this.size / 4, s = this.size / 2
    return (this.children ??= [[-h, -h], [h, -h], [-h, h], [h, h]].map(([du, dv]) => new Node(this.face, this.u + du, this.v + dv, s, this.level + 1, this.R)))
  }
}

function patchGeometry() {
  const n = GRID + 1, pos = [], idx = []
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.push(i / GRID, j / GRID, 0)
  for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1
    idx.push(a, b, c, b, d, c)
  }
  // skirts hide cracks between neighbouring levels
  for (const [start, step] of [[0, 1], [n * (n - 1), 1], [0, n], [n - 1, n]]) {
    for (let k = 0; k < GRID; k++) {
      const a = start + k * step, b = a + step, base = pos.length / 3
      pos.push(pos[a * 3], pos[a * 3 + 1], 1, pos[b * 3], pos[b * 3 + 1], 1)
      idx.push(a, b, base, b, base + 1, base, a, base, b, b, base, base + 1)
    }
  }
  const geo = new THREE.InstancedBufferGeometry()
  geo.setIndex(idx)
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return geo
}

const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _v = new THREE.Vector3(), _m = new THREE.Matrix4()

export class Terrain {
  constructor(scene, renderer) {
    this.scene = scene
    this.renderer = renderer
    this.geo = patchGeometry()
    this.cubeArr = new Float32Array(MAX_INST * 4)
    this.relArr = new Float32Array(MAX_INST * 4)
    this.iCube = new THREE.InstancedBufferAttribute(this.cubeArr, 4).setUsage(THREE.DynamicDrawUsage)
    this.iRel = new THREE.InstancedBufferAttribute(this.relArr, 4).setUsage(THREE.DynamicDrawUsage)
    this.geo.setAttribute('iCube', this.iCube)
    this.geo.setAttribute('iRel', this.iRel)
    this.geo.instanceCount = 0
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicNodeMaterial())
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    scene.add(this.mesh)
    this.frustum = new THREE.Frustum()
    this.sphere = new THREE.Sphere()
    this.body = null
    this.count = 0
  }

  // The body the camera rides with is the one whose terrain we draw.
  candidate(system, cam) {
    let best = null, bestR = Infinity
    for (const b of system.bodies) {
      if (!landable(b)) continue
      const r = b.p.dist(cam) / b.radius
      if (r < bestR) { best = b; bestR = r }
    }
    return bestR < PREP ? best : null
  }

  // Load the elevation map, build the material and compile it before it is needed.
  prepare(b, camera) {
    const P = profile(b)
    if (P.state) return P.state === 'ready'
    P.state = 'loading'
    this.made.push(P)
    source(P).then(src => {
      P.src = src
      P.gpu = terrainMaterial(b, P)
      const probe = new THREE.Mesh(this.geo, P.gpu.mat)
      probe.frustumCulled = false
      const t0 = performance.now()
      return this.renderer.compileAsync(probe, camera, this.scene).then(() => {
        P.compileMs = Math.round(performance.now() - t0)
        P.state = 'ready'
      })
    }).catch(e => { console.warn('terrain: falling back to the sphere for', b.name, e); P.state = 'failed' })
    return false
  }

  // After System.place: choose, activate and rebuild the patch list around the camera.
  update(system, cam, camera, pixAngle) {
    if (system !== this.sys) this.drop(system)
    const b = system ? this.candidate(system, cam) : null
    if (this.body && (this.body !== b || !system?.bodies.includes(this.body) || this.body.p.dist(cam) > this.body.radius * OFF)) this.deactivate()
    if (!b) return
    const ready = this.prepare(b, camera)
    if (!this.body && ready && b.p.dist(cam) < b.radius * ON) this.activate(b)
    if (this.body) this.build(cam, camera, pixAngle)
  }

  // a new system: its bodies are new objects, so free the materials built for the old ones
  drop(system) {
    this.deactivate()
    for (const P of this.made ?? []) P.gpu?.mat.dispose()
    this.made = []
    this.sys = system
  }

  activate(b) {
    this.body = b
    this.P = profile(b)
    this.mesh.material = this.P.gpu.mat
    this.mesh.visible = true
    b.mesh.visible = false
    this.roots = FACES.map((_, f) => new Node(f, 0, 0, 2, 0, this.P.R))
  }
  deactivate() {
    if (this.body) this.body.mesh.visible = true
    this.body = null
    this.mesh.visible = false
  }

  build(cam, camera, pixAngle) {
    const b = this.body, P = this.P, U = P.gpu.U
    const q = b.mesh.quaternion
    const d = cam.sub(b.p)                                                     // metres, world axes
    _v.set(...d).applyQuaternion(_qi.copy(q).invert())
    const c = [_v.x / 1000, _v.y / 1000, _v.z / 1000], r = Math.hypot(...c)   // camera in the body frame, km
    this.cam = c
    this.camDir = c.map(x => x / r)
    const ground = heightAt(b, this.camDir, Math.max(LAM_MIN, (r - P.R) * 1000 / V_RATIO))
    this.gr = P.R + Math.max(ground, 0)
    this.horizon = Math.acos(Math.min(1, this.gr / r)) + Math.acos(P.R / (P.R + P.hMax))
    // frustum planes in the body frame (camera-relative, km)
    _m.makeRotationFromQuaternion(camera.quaternion).invert().premultiply(camera.projectionMatrix).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    this.frustum.setFromProjectionMatrix(_m, camera.coordinateSystem, camera.reversedDepth)
    this.count = 0
    for (const root of this.roots) this.visit(root)
    this.geo.instanceCount = this.count
    this.iCube.needsUpdate = this.iRel.needsUpdate = true
    // shader inputs: rotation, camera-relative lattice offsets, fades
    U.rot.value.setFromMatrix4(_m.makeRotationFromQuaternion(q))
    const cm = c.map(x => x * 1000)
    U.off.array.forEach((o, k) => { const lam = P.lam0 / 2 ** (P.nM + k); o.set(mod(cm[0] / lam, 256), mod(cm[1] / lam, 256), mod(cm[2] / lam, 256)) })
    U.relief.value = 1 - THREE.MathUtils.smoothstep(r / P.R, ON * 0.7, ON)
    U.pix.value = pixAngle
    U.texW.value = P.look.maps ? map(P.look.maps.day, true, true).image?.width ?? 1024 : 1024
    U.cloud.value = THREE.MathUtils.smoothstep(r - P.R, 30, 300)
    this.altitude = (r - this.gr) * 1000
  }

  visit(n) {
    const P = this.P, [dx, dy, dz] = n.dir, [cx, cy, cz] = this.camDir
    const theta = Math.acos(Math.max(-1, Math.min(1, dx * cx + dy * cy + dz * cz)))
    if (theta - (n.edge * 0.8) / P.R > this.horizon) return
    const rx = dx * this.gr - this.cam[0], ry = dy * this.gr - this.cam[1], rz = dz * this.gr - this.cam[2]
    const centre = Math.hypot(rx, ry, rz)
    if (!this.inFrustum(n, rx, ry, rz, Math.min(P.hMax, 0.7 * centre + 0.03))) return
    const dist = centre - n.edge * 0.71
    if (n.level < P.maxLevel && dist < n.edge * SPLIT) { for (const ch of n.split()) this.visit(ch); return }
    if (this.count >= MAX_INST) return
    const i = this.count++ * 4
    this.cubeArr[i] = n.cube[0]; this.cubeArr[i + 1] = n.cube[1]; this.cubeArr[i + 2] = n.cube[2]; this.cubeArr[i + 3] = n.size
    // sea-level centre relative to the camera, in float64
    this.relArr[i] = dx * P.R - this.cam[0]; this.relArr[i + 1] = dy * P.R - this.cam[1]; this.relArr[i + 2] = dz * P.R - this.cam[2]; this.relArr[i + 3] = n.face
  }

  // patch bounds as a vertical stack of spheres: the ground can sit up to v above or below
  inFrustum(n, rx, ry, rz, v) {
    const [dx, dy, dz] = n.dir, s = this.sphere
    s.radius = n.edge * 0.8 + v * 0.5
    for (const k of [0, -1, 1]) {
      s.center.set(rx + dx * v * k, ry + dy * v * k, rz + dz * v * k)
      if (this.frustum.intersectsSphere(s)) return true
    }
    return false
  }

  // ---- hooks for World and Flight ----
  // Ground radius (m) under the camera for a landable body nearby, else null.
  ground(system, b, pos) {
    if (!landable(b) || profile(b).state !== 'ready') return null
    const d = pos.sub(b.p), r = Math.hypot(...d)
    if (r > b.radius * 1.5) return null
    system.orient(b, _q)
    _v.set(d[0] / r, d[1] / r, d[2] / r).applyQuaternion(_q.invert())
    return b.radius + heightAt(b, [_v.x, _v.y, _v.z]) * 1000
  }
  clearance() { return EYE }

  // Near the ground the camera turns with the body it rides on, so the surface holds still.
  corotate(f, system) {
    const b = f.frame
    if (!b || b !== this.body || f.auto) { this.spin = null; return }
    const q = system.orient(b, new THREE.Quaternion())
    if (this.spin && this.spin.b === b) {
      const dq = q.clone().multiply(this.spin.q.clone().invert())
      const l = new THREE.Vector3(...f.local).applyQuaternion(dq)
      f.local = [l.x, l.y, l.z]
      f.quat.premultiply(dq).normalize()
    }
    this.spin = { b, q }
  }

  stats() { return { body: this.body?.name ?? null, patches: this.count, altitude: this.altitude, compileMs: this.body ? profile(this.body).compileMs : null } }
}
export const _probe = { mxFbm, mxPerlin, gnoised, reliefNode, tMacro, profile, macroCPU, reliefCPU }      // test hooks (tools / console)
