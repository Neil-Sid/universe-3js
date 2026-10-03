// Deterministic hashing and random streams. Every procedural object is a pure function of its
// coordinates, like Elite's Stellar Forge: the same cell always yields the same stars.

export function hash(...ints) {
  let h = 0x811c9dc5 | 0
  for (let v of ints) {
    v = Math.floor(v) | 0
    h = Math.imul(h ^ v, 0x01000193)
    h ^= h >>> 15
    h = Math.imul(h, 0x2c1b3c6d)
    h ^= h >>> 12
  }
  h = Math.imul(h ^ (h >>> 16), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

// mulberry32 stream with a few distribution helpers
export class Rng {
  constructor(seed) { this.s = seed >>> 0 }
  next() {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(a, b) { return a + (b - a) * this.next() }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)) }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)] }
  gauss() {
    const u = 1 - this.next(), v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  exp() { return -Math.log(1 - this.next()) }
  // Poisson count; normal approximation for large means
  poisson(mean) {
    if (mean > 40) return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.gauss()))
    const L = Math.exp(-mean)
    let k = 0, p = 1
    do { k++; p *= this.next() } while (p > L)
    return k - 1
  }
  // uniform unit vector
  dir(out = [0, 0, 0]) {
    const z = this.range(-1, 1), a = this.range(0, 2 * Math.PI), r = Math.sqrt(1 - z * z)
    out[0] = r * Math.cos(a); out[1] = r * Math.sin(a); out[2] = z
    return out
  }
}

// Smooth 3D value noise for the large-scale structure fields (CPU side).
function lattice(x, y, z, s) { return hash(x, y, z, s) / 4294967296 }
function fade(t) { return t * t * (3 - 2 * t) }
export function noise3(x, y, z, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi)
  let r = 0
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2
    r += lattice(xi + dx, yi + dy, zi + dz, seed) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w)
  }
  return r
}
export function fbm3(x, y, z, oct = 4, seed = 0) {
  let a = 0.5, s = 0, n = 0
  for (let i = 0; i < oct; i++) { s += a * noise3(x, y, z, seed + i); n += a; x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5 }
  return s / n
}

const SYL = ['ka', 'ro', 'vel', 'thi', 'on', 'sar', 'mi', 'dra', 'ul', 'pe', 'xe', 'no', 'ar', 'tu', 'lia', 'gor', 'shen', 'ae', 'bri', 'cor', 'zan', 'eth', 'ys', 'qua']
export function word(rng, n = rng.int(2, 3)) {
  let s = ''
  for (let i = 0; i < n; i++) s += rng.pick(SYL)
  return s[0].toUpperCase() + s.slice(1)
}
