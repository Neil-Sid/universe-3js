// Universe position: an integer cell index plus a metre offset inside the cell.
// A float64 alone cannot hold "46 billion light years" and "one metre" at once, so the cell carries
// the magnitude and the offset carries the detail. Cells are 2^40 m (~7 AU): the offset stays precise to
// ~0.2 mm (needed to stand on a planet: a 2^50 m cell left only 0.25 m) and the cell index stays exact
// (< 2^53) far beyond the observable universe.
export const CELL = 2 ** 40

export class UPos {
  constructor(cx = 0, cy = 0, cz = 0, x = 0, y = 0, z = 0) {
    this.c = [cx, cy, cz]
    this.o = [x, y, z]
  }
  static meters(x, y, z) { return new UPos().add(x, y, z) }
  clone() { return new UPos(...this.c, ...this.o) }
  copy(p) { this.c[0] = p.c[0]; this.c[1] = p.c[1]; this.c[2] = p.c[2]; this.o[0] = p.o[0]; this.o[1] = p.o[1]; this.o[2] = p.o[2]; return this }

  add(x, y, z) {
    const o = this.o, c = this.c
    o[0] += x; o[1] += y; o[2] += z
    for (let i = 0; i < 3; i++) {
      if (o[i] >= CELL || o[i] < 0) { const k = Math.floor(o[i] / CELL); c[i] += k; o[i] -= k * CELL }
    }
    return this
  }
  addv(v, s = 1) { return this.add(v[0] * s, v[1] * s, v[2] * s) }

  // this - p in metres (float64). Exact cell difference, so nearby things stay precise anywhere.
  sub(p, out = [0, 0, 0]) {
    for (let i = 0; i < 3; i++) out[i] = (this.c[i] - p.c[i]) * CELL + (this.o[i] - p.o[i])
    return out
  }
  dist(p) { const d = this.sub(p, tmp); return Math.hypot(d[0], d[1], d[2]) }
  // absolute metres from the origin (lossy far away; fine for coarse lookups)
  meters(out = [0, 0, 0]) { for (let i = 0; i < 3; i++) out[i] = this.c[i] * CELL + this.o[i]; return out }
}
const tmp = [0, 0, 0]

// 3x3 rotation helpers on plain arrays (row-major)
export function mulMat(m, v, out = [0, 0, 0]) {
  const x = v[0], y = v[1], z = v[2]
  out[0] = m[0] * x + m[1] * y + m[2] * z
  out[1] = m[3] * x + m[4] * y + m[5] * z
  out[2] = m[6] * x + m[7] * y + m[8] * z
  return out
}
export function matMul(a, b) {
  const r = new Array(9)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return r
}
export function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c] }
export function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1] }
// random rotation from a unit quaternion drawn by rng
export function randomRot(rng) {
  const u1 = rng.next(), u2 = rng.next() * 2 * Math.PI, u3 = rng.next() * 2 * Math.PI
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1)
  const x = a * Math.sin(u2), y = a * Math.cos(u2), z = b * Math.sin(u3), w = b * Math.cos(u3)
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
}
