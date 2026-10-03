// Binary and multiple stars. A system's stars form a hierarchy of Kepler pairs: each pair is two
// groups of stars (ga, gb: indices into the star list) orbiting their common barycentre, inner
// pairs listed first. Real systems come from the catalogue; procedural ones from the star's seed.
import { Rng } from './rng.js'
import { matMul, rotX, rotZ } from './upos.js'
import { AU, KM, YEAR, R_SUN } from './units.js'
import { tempColor } from './sprites.js'
import { kepler } from './system.js'

export const GM_SUN = 1.32712440018e20
const TAU = 2 * Math.PI, deg = Math.PI / 180
const orbitPlane = (node, i, peri) => matMul(rotZ(node), matMul(rotX(i), rotZ(peri)))
const sum = (ids, f) => ids.reduce((s, k) => s + f(k), 0)

// ---- generation ---------------------------------------------------------------------------------
// Companions of `star` (mass m1), or null for a single star. Pair planes are local to the system
// frame (procedural) or already galactic (real, flagged `real`).
export function multiple(star, m1) {
  if (star.multiple) return realMultiple(star)
  if (star.real || star.kind === 'blackhole' || star.spec === 'SMBH') return null      // catalogue stars: only known companions
  const rng = new Rng(star.seed ^ 0x2545f491)
  if (rng.next() > multiplicity(m1)) return null
  const A = { ...star, name: `${star.name} A`, mass: m1 }, B = companion(rng, m1, `${star.name} B`)
  const aMin = 4 * (A.R + B.R) * R_SUN / AU
  const aAU = Math.min(3000, Math.max(aMin, 10 ** (1.6 + 0.4 * Math.log10(m1) + 1.1 * rng.gauss())))
  const stars = [A, B], pairs = [pair(rng, `${star.name} AB`, [0], [1], aAU, m1 + B.mass, 0.8)]
  if (rng.next() < (m1 > 2 ? 0.25 : 0.1)) {              // hierarchical triple: a distant third star
    const C = companion(rng, m1, `${star.name} C`), inner = pairs[0]
    const aOut = Math.min(8000, aAU * (1 + inner.e) * rng.range(6, 30))
    stars.push(C)
    pairs.push(pair(rng, `${star.name} ABC`, [0, 1], [2], aOut, m1 + B.mass + C.mass, 0.4))
  }
  return { stars, pairs }
}

// Fraction of stars with companions rises with mass (Duchêne & Kraus 2013)
const multiplicity = m => m < 0.08 ? 0.15 : m < 0.5 ? 0.25 : m < 0.8 ? 0.35 : m < 1.1 ? 0.45 : m < 1.6 ? 0.5 : m < 2.5 ? 0.6 : 0.7

// Mass ratio roughly flat with a twin excess; some companions are white dwarfs or brown dwarfs.
function companion(rng, m1, name) {
  if (rng.next() < 0.08) {
    const T = rng.range(5000, 28000), R = rng.range(0.009, 0.014)
    return { name, spec: 'D', mass: 0.6, T, R, L: R * R * (T / 5772) ** 4 }
  }
  const q = rng.next() < 0.15 ? rng.range(0.95, 1) : rng.range(0.1, 1)
  return { name, ...dwarfOfMass(Math.min(q * m1, 40)) }
}

// Main-sequence (or brown dwarf) star of mass m (M_sun) from simple mass relations.
function dwarfOfMass(m) {
  if (m < 0.075) return m > 0.05 ? { spec: 'L', mass: m, L: 1e-4, T: 1900, R: 0.1 } : { spec: 'T', mass: m, L: 1.5e-5, T: 950, R: 0.09 }
  const L = m < 0.43 ? 0.23 * m ** 2.3 : m < 2 ? m ** 4 : 1.4 * m ** 3.5
  const R = m < 1 ? m ** 0.8 : m ** 0.57
  const T = 5772 * (L / (R * R)) ** 0.25
  const spec = T > 30000 ? 'O' : T > 10000 ? 'B' : T > 7500 ? 'A' : T > 6000 ? 'F' : T > 5200 ? 'G' : T > 3700 ? 'K' : 'M'
  return { spec, mass: m, L, T, R }
}

function pair(rng, name, ga, gb, aAU, M, eMax) {
  const e = aAU < 0.1 ? 0.02 * rng.next() : eMax * rng.next() ** 0.8      // tight pairs are tidally circularised
  const a = aAU * AU
  return { name, ga, gb, a, e, n: Math.sqrt(GM_SUN * M / a ** 3), M0: rng.range(0, TAU), plane: orbitPlane(rng.range(0, TAU), rng.gauss() * 0.15, rng.range(0, TAU)) }
}

// Catalogue systems: the first member is the catalogue star itself.
function realMultiple(star) {
  const m = star.multiple
  const stars = m.stars.map(([name, mass, spec, L, T, R], k) => k === 0 ? { ...star, name, mass } : { name, mass, spec, L, T, R, real: true })
  const pairs = m.orbits.map(([name, ga, gb, P, aAU, e, i, node, peri, tp]) => ({
    name, ga, gb, a: aAU * AU, e, n: TAU / (P * YEAR), M0: TAU * (2000 - tp) / P, plane: matMul(m.sky, orbitPlane(node * deg, i * deg, peri * deg)), real: true,
  }))
  return { stars, pairs, name: m.system }
}

// Where planets can orbit: the innermost host (star 0, or a pair holding it) with room for a few.
// S-type orbits stay inside a third of the enclosing pair's periastron; P-type (circumbinary) ones
// start beyond ~2.5-4 binary separations (Holman & Wiegert 1999).
export function planetZone(mult, a0) {
  let host = { star: 0 }, members = [0], lo = 0
  for (const [k, p] of (mult?.pairs ?? []).entries()) {
    if (!p.ga.includes(0) && !p.gb.includes(0)) continue
    const hi = p.a * (1 - p.e) / 3
    if (hi > Math.max(lo, a0) * 3) return { host, members, lo, hi }
    host = { pair: k }; members = [...p.ga, ...p.gb]; lo = p.a * (2.5 + 3 * p.e)
  }
  return { host, members, lo, hi: Infinity }
}

// ---- runtime ------------------------------------------------------------------------------------
// Star bodies and pair barycentres for a System; returns the primary star body.
export function buildStars(sys, spec, origin) {
  const list = spec.stars ?? [{ ...spec.star, mass: spec.mass ?? 1 }]
  sys.bary = origin.clone()
  sys.stars = list.map((s, k) => Object.assign(sys.addStar(s, origin, k === 0), { msun: s.mass ?? 1, rgb: tempColor(s.T) }))
  sys.pairs = (spec.pairs ?? []).map(p => {
    const members = [...p.ga, ...p.gb], mass = ids => sum(ids, k => sys.stars[k].msun)
    const ma = mass(p.ga), mb = mass(p.gb), M = ma + mb
    // each side's path around the barycentre: the relative orbit scaled by the other side's share
    const lines = [[mb / M, matMul(p.plane, rotZ(Math.PI))], [ma / M, p.plane]].map(([f, plane]) => {
      const l = sys.orbitLine({ a: p.a * f, e: p.e, plane }, false)
      l.material.color.setHex(0xd9a36a)
      return l
    })
    return { ...p, name: p.name ?? members.map(k => sys.stars[k].name).join(' + '), members, msun: M, p: origin.clone(), lines }
  })
  sys.stars.forEach((b, k) => {
    b.companions = sys.stars.filter(o => o !== b).map(o => ({ name: o.name, spec: o.spec }))
    const p = sys.pairs.find(p => p.members.includes(k))
    if (p) b.binary = { a: p.a, P: TAU / p.n, around: p.name }
  })
  return sys.stars[0]
}

export const hostOf = (sys, h) => h?.pair != null ? sys.pairs[h.pair] : sys.stars[h?.star ?? 0]

// Each star's offset from the system barycentre at time t (metres); masses in M_sun.
const rel = [0, 0, 0]
export function starOffsets(masses, pairs, t, out = []) {
  masses.forEach((_, k) => (out[k] ??= [0, 0, 0]).fill(0))
  for (const p of pairs) {
    kepler(p, t, rel)
    const ma = sum(p.ga, k => masses[k]), mb = sum(p.gb, k => masses[k]), M = ma + mb
    for (const k of p.ga) for (let j = 0; j < 3; j++) out[k][j] -= rel[j] * mb / M
    for (const k of p.gb) for (let j = 0; j < 3; j++) out[k][j] += rel[j] * ma / M
  }
  return out
}

// Put every star and pair barycentre where it is at time t.
const off = []
export function moveStars(sys, t) {
  const S = sys.stars, masses = S.map(s => s.msun)
  starOffsets(masses, sys.pairs, t, off)
  S.forEach((s, k) => s.p.copy(sys.bary).addv(off[k]))
  for (const p of sys.pairs) {
    rel.fill(0)
    for (const k of p.members) for (let j = 0; j < 3; j++) rel[j] += off[k][j] * masses[k] / p.msun
    p.p.copy(sys.bary).addv(rel)
  }
}

// Light falling on a point: flux-weighted direction and colour of all the stars, and the
// brightness term the planet shader uses. For S-type worlds the host dominates by far.
const light = { dir: [0, 0, 0], rgb: [0, 0, 0], light: 0 }, d = [0, 0, 0]
export function starLight(sys, pos) {
  let F = 0
  light.dir.fill(0); light.rgb.fill(0)
  for (const s of sys.stars) {
    s.p.sub(pos, d)
    const r = Math.hypot(d[0], d[1], d[2]), f = s.L / (r * r / (AU * AU))
    if (!(f > 0)) continue
    for (let j = 0; j < 3; j++) { light.dir[j] += d[j] / r * f; light.rgb[j] += s.rgb[j] * f }
    F += f
  }
  if (F > 0) { for (let j = 0; j < 3; j++) light.rgb[j] /= F }
  else { sys.star.p.sub(pos, light.dir); light.rgb.splice(0, 3, ...sys.star.rgb) }
  const len = Math.hypot(...light.dir) || 1
  for (let j = 0; j < 3; j++) light.dir[j] /= len
  light.light = Math.min(2, F ** 0.15)
  return light
}

// Stellar orbit lines, centred on each pair's barycentre.
export function placeStarOrbits(sys, cam, show) {
  for (const p of sys.pairs) {
    p.p.sub(cam, rel)
    const near = Math.hypot(...rel) < p.a * 400
    for (const l of p.lines) { l.position.set(rel[0] / KM, rel[1] / KM, rel[2] / KM); l.visible = show && near }
  }
}
