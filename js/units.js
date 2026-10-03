// Physical constants (SI metres) and human-readable formatting.
export const KM = 1e3
export const R_SUN = 6.957e8
export const R_EARTH = 6.371e6
export const AU = 1.495978707e11
export const LY = 9.4607304725808e15
export const PC = 3.0856775814914e16
export const KPC = PC * 1e3
export const MPC = PC * 1e6
export const C = 299792458
export const DAY = 86400
export const YEAR = 365.25 * DAY
export const G = 6.674e-11
export const M_SUN = 1.989e30
export const OBSERVABLE_RADIUS = 14.25e3 * MPC      // comoving radius of the observable universe (46.5 Gly)

// [upper bound, unit, label]: each unit is used until the next one reads better
const ladder = [
  [1e3, 1, 'm'], [1e10, KM, 'km'], [0.05 * LY, AU, 'AU'], [1e5 * LY, LY, 'ly'],
  [MPC, KPC, 'kpc'], [1e3 * MPC, MPC, 'Mpc'], [Infinity, 1e3 * MPC, 'Gpc'],
]

export function fmtDist(m) {
  if (!isFinite(m)) return '∞'
  const [, u, s] = ladder.find(([max]) => Math.abs(m) < max)
  return num(m / u) + ' ' + s
}

export function fmtSpeed(ms) {
  const a = Math.abs(ms)
  if (a >= 0.1 * C) {
    if (a >= MPC) return num(ms / MPC) + ' Mpc/s'
    if (a >= LY) return num(ms / LY) + ' ly/s'
    return num(ms / C) + ' c'
  }
  if (a >= 1e3) return num(ms / 1e3) + ' km/s'
  return num(ms) + ' m/s'
}

export function num(x) {
  const a = Math.abs(x)
  if (a >= 1e6) return x.toExponential(2).replace('e+', '·10^')
  if (a >= 100) return Math.round(x).toLocaleString('en-US')
  if (a >= 10) return x.toFixed(1)
  if (a >= 0.01 || a === 0) return x.toFixed(2)
  return x.toExponential(2)
}

export const deg = Math.PI / 180
