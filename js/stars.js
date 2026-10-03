// Star streaming. Each spectral class is its own octree level ("boxels" in Elite's Stellar Forge):
// rare bright classes use big cells and a long reach, common dim ones small cells and a short
// reach. Cells are generated from a hash of their coordinates, so every star has a permanent
// place and identity. Positions are in the current galaxy's frame, in light years.
import { Rng, hash, word } from './rng.js'
import { starSprites, upload, tempColor } from './sprites.js'
import { density } from './galaxy.js'
import { LY, R_SUN } from './units.js'

const BASE_DENSITY = 0.004                  // stars per cubic ly around the Sun

// class, fraction of all stars, log10 L range, T range (K), R range (R_sun), reach (ly)
export const CLASSES = [
  ['M', 0.745, [-3.5, -1.1], [2400, 3700], [0.1, 0.62], 38],
  ['K', 0.121, [-1.1, -0.22], [3700, 5200], [0.62, 0.96], 90],
  ['G', 0.076, [-0.22, 0.18], [5200, 6000], [0.96, 1.15], 150],
  ['F', 0.03, [0.18, 0.7], [6000, 7500], [1.15, 1.4], 230],
  ['A', 0.006, [0.7, 1.4], [7500, 10000], [1.4, 2.1], 420],
  ['B', 0.0013, [1.4, 4.4], [10000, 30000], [2.1, 6.6], 1500],
  ['O', 3e-7, [4.5, 6], [30000, 45000], [6.6, 15], 12000],
  ['K III', 0.004, [1.7, 3], [3500, 5000], [10, 60], 1100],
  ['M I', 1e-6, [4, 5.4], [3300, 4200], [300, 1200], 12000],
  ['D', 0.06, [-4, -2], [5000, 30000], [0.008, 0.02], 16],
  ['L', 0.08, [-4.3, -3.4], [1300, 2400], [0.09, 0.12], 16],        // brown dwarfs: too cool to fuse hydrogen
  ['T', 0.12, [-5.8, -4.5], [550, 1300], [0.08, 0.11], 12],
  ['G III', 0.0008, [1.4, 2.1], [4900, 5600], [6, 15], 700],         // yellow giants
  ['B I', 3e-7, [4.6, 5.7], [11000, 26000], [20, 80], 12000],        // blue supergiants
]
const CELLS_ACROSS = 5                      // a level's reach spans about this many cells

export class StarLevel {
  constructor(k) {
    const [name, frac, logL, T, R, reach] = CLASSES[k]
    Object.assign(this, { k, name, frac, logL, T, R, reach, cells: new Map(), anchor: null, key: '' })
    this.cell = reach / CELLS_ACROSS
    this.cap = 70000
    this.skew = ['A', 'B', 'O', 'K III', 'M I', 'G III', 'B I'].includes(name)
    this.sprites = starSprites(this.cap, { gain: 100, hideNear: 0.02, fadeFar: reach })
  }

  // Stars of one cell, deterministic. Local density comes from the galaxy model.
  genCell(g, i, j, k, c) {
    const cx = (i + 0.5) * c, cy = (j + 0.5) * c, cz = (k + 0.5) * c
    const rho = density(g, cx, cy, cz)
    const rng = new Rng(hash(g.seed, this.k, i, j, k))
    const n = rng.poisson(BASE_DENSITY * this.frac * rho * c * c * c)
    const cell = { n: 0, pos: new Float64Array(n * 3), col: new Float32Array(n * 3), lum: new Float32Array(n), T: new Float32Array(n), R: new Float32Array(n), seed: new Uint32Array(n) }
    const col = [0, 0, 0]
    for (let s = 0; s < n; s++) {
      const x = (i + rng.next()) * c, y = (j + rng.next()) * c, z = (k + rng.next()) * c
      // thin the cell by the local density gradient so the disk edge and arms stay sharp
      if (rng.next() * 1.3 > density(g, x, y, z) / Math.max(rho, 1e-9)) continue
      if (g.id === 'milky-way' && Math.hypot(x + 26670, y, z - 21) < 4.6) continue   // keep the Sun's neighbourhood to the catalogue
      const t = this.skew ? rng.next() ** 3 : rng.next()          // rare luminous classes: most sit at the faint end
      const m = cell.n++
      cell.pos[m * 3] = x; cell.pos[m * 3 + 1] = y; cell.pos[m * 3 + 2] = z
      cell.lum[m] = 10 ** (this.logL[0] + (this.logL[1] - this.logL[0]) * t)
      cell.T[m] = this.T[0] + (this.T[1] - this.T[0]) * (this.name === 'D' ? rng.next() : t)
      cell.R[m] = this.R[0] + (this.R[1] - this.R[0]) * t
      tempColor(cell.T[m], col)
      cell.col.set(col, m * 3)
      cell.seed[m] = hash(g.seed, this.k, i, j, k, s)
    }
    return cell
  }

  // Keep the cells around `p` (galaxy frame, ly) loaded, spending at most `budget` ms.
  update(g, p, budget, reachScale) {
    const reach = this.reach * reachScale
    const c = this.cell * reachScale
    const r = Math.ceil(reach / c)
    const ci = Math.floor(p[0] / c), cj = Math.floor(p[1] / c), ck = Math.floor(p[2] / c)
    const key = `${g.id}|${ci},${cj},${ck}|${c}`
    if (key === this.key && !this.pending) return false
    if (c !== this.cellSize0 || g.id !== this.gid) { this.cells.clear(); this.cellSize0 = c }
    const t0 = performance.now()
    const want = new Set()
    const todo = []
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
      if ((i * i + j * j + k * k) * c * c > (reach + c * 1.8) ** 2) continue
      const id = `${ci + i},${cj + j},${ck + k}`
      want.add(id)
      if (!this.cells.has(id)) todo.push([ci + i, cj + j, ck + k, id, i * i + j * j + k * k])
    }
    todo.sort((a, b) => a[4] - b[4])
    let done = 0
    for (const [i, j, k, id] of todo) {
      if (performance.now() - t0 > budget && done > 0) break
      this.cells.set(id, this.genCell(g, i, j, k, c)); done++
    }
    for (const id of this.cells.keys()) if (!want.has(id)) this.cells.delete(id)
    this.pending = done < todo.length
    this.key = key
    this.merge(p, g.id)
    this.sprites.u.fadeFar.value = reach
    return true
  }

  // Pack loaded cells into one instance buffer relative to an anchor, so float32 stays precise.
  merge(p, gid) {
    const anchor = [p[0], p[1], p[2]]
    let n = 0
    for (const cell of this.cells.values()) n += cell.n
    n = Math.min(n, this.cap)
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), lum = new Float32Array(n)
    let m = 0
    for (const cell of this.cells.values()) {
      for (let s = 0; s < cell.n && m < n; s++, m++) {
        pos[m * 3] = cell.pos[s * 3] - anchor[0]; pos[m * 3 + 1] = cell.pos[s * 3 + 1] - anchor[1]; pos[m * 3 + 2] = cell.pos[s * 3 + 2] - anchor[2]
        col[m * 3] = cell.col[s * 3]; col[m * 3 + 1] = cell.col[s * 3 + 1]; col[m * 3 + 2] = cell.col[s * 3 + 2]
        lum[m] = cell.lum[s]
      }
    }
    upload(this.sprites.geometry, { iPos: pos, iColor: col, iLum: lum }, n)
    this.anchor = anchor
    this.gid = gid
  }

  clear() { this.cells.clear(); this.key = ''; this.sprites.geometry.instanceCount = 0 }

  // All stars within `r` ly of p: calls fn(cell, index, d2)
  near(p, r, fn) {
    const c = this.cellSize0 || this.cell
    const lo = [0, 1, 2].map(a => Math.floor((p[a] - r) / c)), hi = [0, 1, 2].map(a => Math.floor((p[a] + r) / c))
    if ((hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) > 125) return
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
      const cell = this.cells.get(`${i},${j},${k}`)
      if (!cell) continue
      for (let s = 0; s < cell.n; s++) {
        const dx = cell.pos[s * 3] - p[0], dy = cell.pos[s * 3 + 1] - p[1], dz = cell.pos[s * 3 + 2] - p[2]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 < r * r) fn(cell, s, d2)
      }
    }
  }
}

// A star as a visitable object. Name derived from its seed; real stars keep theirs.
export function starFromCell(g, level, cell, s) {
  const seed = cell.seed[s]
  const rng = new Rng(seed)
  const name = `${word(rng, 2)} ${String.fromCharCode(65 + rng.int(0, 25))}${String.fromCharCode(65 + rng.int(0, 25))}-${rng.int(1, 999)}`
  return {
    kind: 'star', id: 'p' + seed, name, seed, galaxy: g, spec: level.name, L: cell.lum[s], T: cell.T[s], R: cell.R[s],
    radius: cell.R[s] * R_SUN, local: [cell.pos[s * 3], cell.pos[s * 3 + 1], cell.pos[s * 3 + 2]],
  }
}

// The real catalogue as its own always-loaded sprite set (Milky Way only, anchored at the Sun).
export class CatalogStars {
  constructor(stars) {
    this.stars = stars
    this.sprites = starSprites(stars.length, { gain: 100, hideNear: 0.02 })
    const pos = new Float32Array(stars.length * 3), col = new Float32Array(stars.length * 3), lum = new Float32Array(stars.length)
    stars.forEach((s, i) => {
      pos.set(s.pos.map(v => v / LY), i * 3)
      col.set(tempColor(s.T), i * 3)
      lum[i] = s.Lsys ?? s.L                        // a multiple system shows its combined light
    })
    upload(this.sprites.geometry, { iPos: pos, iColor: col, iLum: lum }, stars.length)
  }
}

export function starObject(g, s) {
  return { kind: 'star', id: 'real:' + s.name, name: s.name, seed: s.seed, galaxy: g, spec: s.spec, L: s.L, T: s.T, R: s.R, radius: s.R * R_SUN, real: true, helio: s.pos, mass: s.mass, multiple: s.multiple }
}
