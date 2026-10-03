// Real objects placed at their catalogued positions. Everything else is procedural.
// Frame: heliocentric galactic coordinates in metres. x toward the Galactic Centre (l = 0),
// y toward l = 90 (the direction the Sun orbits), z toward the north galactic pole.
import { AU, LY, MPC, KM, R_SUN, deg } from './units.js'
import { matMul, mulMat, rotX } from './upos.js'

// ICRS equatorial -> galactic (J2000)
export const EQ_TO_GAL = [
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.4448296300, 0.7469822445,
  -0.8676661490, -0.1980763734, 0.4559837762,
]
// ecliptic J2000 -> galactic: tilt by the obliquity into equatorial first
export const ECL_TO_GAL = matMul(EQ_TO_GAL, rotX(23.4392911 * deg))

export function fromRaDec(raHours, decDeg, dist) {
  const a = raHours * 15 * deg, d = decDeg * deg
  const v = mulMat(EQ_TO_GAL, [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)])
  return [v[0] * dist, v[1] * dist, v[2] * dist]
}
export function fromLB(lDeg, bDeg, dist) {
  const l = lDeg * deg, b = bDeg * deg
  return [Math.cos(b) * Math.cos(l) * dist, Math.cos(b) * Math.sin(l) * dist, Math.sin(b) * dist]
}

// ---- The Milky Way: the Sun sits 26,670 ly from the centre, ~21 ly above the mid-plane.
// Arms are the log-spiral fits of Reid et al. 2019 (ApJ 885, 131; R0 = 8.15 kpc): ln(R/Rkink) =
// -(beta - beta_kink) tan(pitch), beta = Galactocentric azimuth (deg, 0 toward the Sun, growing with
// Galactic rotation). kink [beta, R kpc], width = Gaussian sigma at the kink (kpc), segs [from, to,
// pitch deg]. Segments past the parallax data follow their extrapolation (4 arms joined behind the
// centre: Norma becomes the Outer arm, Scutum-Centaurus the OSC). old/young: weight in old stars / star formation.
const MW_ARMS = [
  { name: 'Scutum-Centaurus', kink: [23, 4.91], width: 0.23, old: 1, young: 1, segs: [[-235, 23, 14.1], [23, 62, 12.1]] },
  { name: 'Perseus', kink: [40, 8.87], width: 0.35, old: 1, young: 0.65, segs: [[-110, 40, 10.3], [40, 250, 8.7]] },
  { name: 'Sagittarius-Carina', kink: [24, 6.04], width: 0.27, old: 0.4, young: 1, segs: [[-190, -33, 10], [-33, 24, 17.1], [24, 97, 1.0], [97, 222, 8.5]] },
  { name: 'Norma-Outer', kink: [18, 4.46], width: 0.14, old: 0.4, young: 0.8, segs: [[-400, -342, 3.0], [-342, -289, 9.4], [-289, -30, 10.9], [-30, 18, -1.0], [18, 56, 19.5]] },
  { name: 'Local Spur', kink: [9, 8.26], width: 0.31, old: 0.2, young: 0.5, segs: [[-22, 9, 11.4], [9, 42, 11.4]] },
]
export const MILKY_WAY = {
  id: 'milky-way', name: 'Milky Way', real: true, type: 'spiral', R: 52000, hR: 8500, hz: 900, arms: 4,
  pitch: 12.5 * deg, phase: 0.6, bulge: 3600, seed: 7, lum: 1,
  bar: 16300, barAngle: -27 * deg,          // long bar: half-length ~5 kpc, near end at positive longitude, 27 deg off the Sun-centre line
  armTable: MW_ARMS, R0kpc: 8.15,
  centerLy: [26670, 0, -21], normal: [0, 0, 1], tint: [1, 1, 1],
}

// name, RA (h), Dec (deg), distance (ly), spectral type, L (L_sun), T (K), R (R_sun)
const STARS = [
  ['Proxima Centauri', 14.4953, -62.6795, 4.2465, 'M5.5 V', 0.0017, 3042, 0.154],
  ['Alpha Centauri A', 14.6601, -60.8340, 4.367, 'G2 V', 1.519, 5790, 1.2175],
  ['Alpha Centauri B', 14.6599, -60.8375, 4.367, 'K1 V', 0.5, 5260, 0.8591],
  ["Barnard's Star", 17.9635, 4.6934, 5.963, 'M4 V', 0.0035, 3134, 0.196],
  ['Wolf 359', 10.9414, 7.0147, 7.86, 'M6 V', 0.0014, 2800, 0.144],
  ['Lalande 21185', 11.0556, 35.97, 8.31, 'M2 V', 0.021, 3547, 0.39],
  ['Sirius', 6.7525, -16.7161, 8.60, 'A1 V', 25.4, 9940, 1.711],
  ['Epsilon Eridani', 3.5488, -9.4583, 10.47, 'K2 V', 0.34, 5084, 0.735],
  ['61 Cygni A', 21.1150, 38.7494, 11.40, 'K5 V', 0.153, 4526, 0.665],
  ['Procyon', 7.6550, 5.225, 11.46, 'F5 IV', 6.93, 6530, 2.048],
  ['Tau Ceti', 1.7345, -15.9375, 11.91, 'G8 V', 0.52, 5344, 0.793],
  ['Altair', 19.8464, 8.8683, 16.73, 'A7 V', 10.6, 7550, 1.8],
  ['Vega', 18.6156, 38.7837, 25.04, 'A0 V', 40.1, 9602, 2.36],
  ['Fomalhaut', 22.9608, -29.6222, 25.13, 'A3 V', 16.6, 8590, 1.84],
  ['Pollux', 7.7553, 28.0262, 33.78, 'K0 III', 32.7, 4666, 9.06],
  ['Arcturus', 14.2610, 19.1824, 36.7, 'K1.5 III', 170, 4286, 25.4],
  ['TRAPPIST-1', 23.1081, -5.0414, 40.66, 'M8 V', 0.00055, 2566, 0.119],
  ['Capella', 5.2782, 45.998, 42.9, 'K0 III', 78.7, 4970, 11.98],
  ['Castor', 7.5767, 31.8883, 51, 'A1 V', 30, 10286, 2.4],
  ['Aldebaran', 4.5987, 16.5093, 65.3, 'K5 III', 439, 3910, 44.2],
  ['Regulus', 10.1395, 11.9672, 79.3, 'B8 IV', 288, 12460, 4.35],
  ['Spica', 13.4199, -11.1614, 250, 'B1 V', 20500, 25300, 7.47],
  ['Canopus', 6.3992, -52.6958, 310, 'A9 II', 10700, 7400, 71],
  ['Polaris', 2.5303, 89.2641, 433, 'F7 Ib', 1260, 6015, 37.5],
  ['Betelgeuse', 5.9195, 7.4070, 548, 'M1 Iab', 126000, 3600, 764],
  ['Antares', 16.4901, -26.432, 550, 'M1.5 Iab', 75900, 3660, 680],
  ['Rigel', 5.2423, -8.2016, 860, 'B8 Ia', 120000, 12100, 78.9],
  ['Deneb', 20.6905, 45.2803, 2615, 'A2 Ia', 196000, 8525, 203],
  ['VY Canis Majoris', 7.3829, -25.7675, 3900, 'M3 Ia', 270000, 3490, 1420],
  ['UY Scuti', 18.4601, -12.4664, 5900, 'M4 Ia', 86000, 3365, 909],
  ['Eta Carinae', 10.7510, -59.6844, 7500, 'LBV', 4.6e6, 9400, 240],
]

export const SUN = { name: 'Sun', spec: 'G2 V', L: 1, T: 5772, R: 1, pos: [0, 0, 0], real: true, seed: 1 }

// Multiple systems, keyed by the catalogue star that stands for the whole system (its position is
// taken as the barycentre). Members: [name, mass (M_sun), spectral type, L, T, R]; the first is the
// catalogue star itself and a bare [name, mass] borrows that STARS row. Orbits (inner pairs first):
// [name, group a, group b, P (yr), a (AU), e, i, node, periastron arg (deg, plane of the sky),
// periastron epoch (yr)].
const MULTIPLES = {
  'Alpha Centauri A': { system: 'Alpha Centauri',
    stars: [['Alpha Centauri A', 1.0788], ['Alpha Centauri B', 0.9092]],
    orbits: [['Alpha Centauri AB', [0], [1], 79.91, 23.4, 0.5208, 79.24, 205.06, 231.52, 2035.5]] },
  'Sirius': { system: 'Sirius',
    stars: [['Sirius A', 2.063], ['Sirius B', 1.018, 'DA2', 0.056, 25000, 0.0084]],
    orbits: [['Sirius AB', [0], [1], 50.13, 19.8, 0.5923, 136.34, 45.4, 149.16, 1994.57]] },
  'Procyon': { system: 'Procyon',
    stars: [['Procyon A', 1.499], ['Procyon B', 0.602, 'DQZ', 0.00049, 7740, 0.01234]],
    orbits: [['Procyon AB', [0], [1], 40.84, 15.1, 0.40, 31.1, 97.3, 92.2, 1967.97]] },
  '61 Cygni A': { system: '61 Cygni',
    stars: [['61 Cygni A', 0.70], ['61 Cygni B', 0.63, 'K7 V', 0.085, 4077, 0.595]],
    orbits: [['61 Cygni AB', [0], [1], 678, 84.5, 0.40, 51, 178, 149, 1709]] },
  'Capella': { system: 'Capella',
    stars: [['Capella Aa', 2.569], ['Capella Ab', 2.483, 'G1 III', 72.7, 5730, 8.83]],
    orbits: [['Capella A', [0], [1], 0.28479, 0.743, 0.0089, 137.16, 40.52, 342.6, 2000]] },
  // Castor A and B are each spectroscopic binaries with red-dwarf partners
  'Castor': { system: 'Castor',
    stars: [['Castor Aa', 2.37], ['Castor Ab', 0.5, 'M1 V', 0.035, 3700, 0.5], ['Castor Ba', 1.79, 'A2 Vm', 13, 8300, 1.8], ['Castor Bb', 0.5, 'M2 V', 0.03, 3600, 0.5]],
    orbits: [['Castor A', [0], [1], 0.025223, 0.122, 0.499, 60, 20, 265, 2000], ['Castor B', [2], [3], 0.0080172, 0.0528, 0, 70, 160, 0, 2000],
      ['Castor AB', [0, 1], [2, 3], 445, 100.7, 0.33, 114.5, 41.3, 248, 1958]] },
}

// Plane-of-the-sky frame at (RA, Dec) in galactic coordinates: columns north, east, toward us.
function skyFrame(raHours, decDeg) {
  const a = raHours * 15 * deg, d = decDeg * deg, sa = Math.sin(a), ca = Math.cos(a), sd = Math.sin(d), cd = Math.cos(d)
  const [n, e, t] = [[-sd * ca, -sd * sa, cd], [-sa, ca, 0], [-cd * ca, -cd * sa, -sd]].map(v => mulMat(EQ_TO_GAL, v))
  return [n[0], e[0], t[0], n[1], e[1], t[1], n[2], e[2], t[2]]
}
const row = name => STARS.find(r => r[0] === name)
function multipleOf(name, ra, dec) {
  const m = MULTIPLES[name]
  if (!m) return null
  const stars = m.stars.map((s, k) => k > 0 && s.length === 2 ? [...s, ...row(s[0]).slice(4)] : s)
  return { ...m, stars, sky: skyFrame(ra, dec) }
}
// companions drawn inside their system, not as catalogue points of their own
const COMPANIONS = new Set(Object.values(MULTIPLES).flatMap(m => m.stars.slice(1).map(s => s[0])))

export const REAL_STARS = [SUN, ...STARS.map(([name, ra, dec, ly, spec, L, T, R], i) => {
  const multiple = multipleOf(name, ra, dec)
  const extra = multiple && { multiple, mass: multiple.stars[0][1], Lsys: L + multiple.stars.slice(1).reduce((s, m) => s + m[3], 0) }
  return { name, spec, L, T, R, pos: fromRaDec(ra, dec, ly * LY), real: true, seed: 1000 + i, ...extra }
}).filter(s => !COMPANIONS.has(s.name))]

// ---- Solar System. J2000 mean elements (Standish): a (AU), e, i, mean longitude L, longitude
// of perihelion w~, node O (degrees). Radii in km, rotation in hours, tilt in degrees.
const PLANETS = [
  ['Mercury', 0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593, 2439.7, 1407.6, 0.03, 'mercury'],
  ['Venus', 0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255, 6051.8, -5832.5, 177.4, 'venus'],
  ['Earth', 1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0, 6371.0, 23.934, 23.44, 'earth'],
  ['Mars', 1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 3389.5, 24.623, 25.19, 'mars'],
  ['Jupiter', 5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, 69911, 9.925, 3.13, 'jupiter'],
  ['Saturn', 9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, 58232, 10.656, 26.73, 'saturn'],
  ['Uranus', 19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503, 25362, -17.24, 97.77, 'uranus'],
  ['Neptune', 30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 24622, 16.11, 28.32, 'neptune'],
  ['Pluto', 39.48211675, 0.2488273, 17.14001206, 238.92903833, 224.06891629, 110.30393684, 1188.3, -153.3, 122.5, 'pluto'],
]
// parent, name, a (km), e, i (deg, to parent equator; Moon to ecliptic), R (km), period (days)
const MOONS = [
  ['Earth', 'Moon', 384400, 0.0549, 5.145, 1737.4, 27.3217, 'moon'],
  ['Mars', 'Phobos', 9376, 0.0151, 1.08, 11.27, 0.31891, 'rock'],
  ['Mars', 'Deimos', 23463, 0.00033, 1.79, 6.2, 1.263, 'rock'],
  ['Jupiter', 'Io', 421700, 0.0041, 0.05, 1821.6, 1.769, 'io'],
  ['Jupiter', 'Europa', 671034, 0.009, 0.47, 1560.8, 3.551, 'europa'],
  ['Jupiter', 'Ganymede', 1070412, 0.0013, 0.2, 2634.1, 7.155, 'ganymede'],
  ['Jupiter', 'Callisto', 1882709, 0.0074, 0.19, 2410.3, 16.689, 'callisto'],
  ['Saturn', 'Enceladus', 237948, 0.0047, 0.02, 252.1, 1.370, 'ice'],
  ['Saturn', 'Rhea', 527108, 0.0013, 0.35, 763.8, 4.518, 'ice'],
  ['Saturn', 'Titan', 1221870, 0.0288, 0.35, 2574.7, 15.945, 'titan'],
  ['Saturn', 'Iapetus', 3560820, 0.0286, 15.47, 734.5, 79.32, 'iapetus'],
  ['Uranus', 'Titania', 435910, 0.0011, 0.34, 788.4, 8.706, 'ice'],
  ['Neptune', 'Triton', 354759, 0.000016, 156.9, 1353.4, -5.877, 'triton'],
  ['Pluto', 'Charon', 19591, 0.0002, 0.08, 606, 6.387, 'ice'],
]

const SOL_KINDS = { Mercury: 'rock', Venus: 'venus', Earth: 'ocean', Mars: 'marslike', Jupiter: 'gas', Saturn: 'gas', Uranus: 'icegiant', Neptune: 'icegiant', Pluto: 'dwarf' }

export function solarSystemSpec() {
  const planets = PLANETS.map(([name, a, e, i, L, wbar, O, rkm, rotH, tilt, look]) => ({
    name, look, kind: SOL_KINDS[name], radius: rkm * KM, a: a * AU, e, i: i * deg, node: O * deg, peri: (wbar - O) * deg,
    M0: (L - wbar) * deg, rotation: rotH * 3600, tilt: tilt * deg,
    // Earth turns by the Earth Rotation Angle (IERS), so its day side matches real UTC
    ...(name === 'Earth' && { rotation: 86400 / 1.00273781191135448, spinPhase: 2 * Math.PI * 0.779057273264 }),
    rings: name === 'Saturn' ? [74500 * KM, 140200 * KM] : name === 'Uranus' ? [41800 * KM, 51150 * KM] : null,
  }))
  const moons = MOONS.map(([parent, name, akm, e, i, rkm, days, look]) => ({
    parent, name, look, radius: rkm * KM, a: akm * KM, e, i: i * deg, node: 0, peri: 0,
    M0: (name.length * 1.7) % (2 * Math.PI), period: Math.abs(days) * 86400, retro: days < 0,
    locked: true, tilt: 0, eclipticPlane: name === 'Moon',
  }))
  return { star: { ...SUN, radius: R_SUN }, planets, moons, frame: ECL_TO_GAL }
}

// ---- Nearby real galaxies: name, galactic l, b (deg), distance (Mpc), type, radius (ly),
// inclination (deg), arm count, brightness
const GALAXIES = [
  ['Andromeda (M31)', 121.17, -21.57, 0.765, 'spiral', 76000, 77, 2, 1.3],
  ['Triangulum (M33)', 133.61, -31.33, 0.86, 'spiral', 30000, 55, 2, 0.8],
  ['Large Magellanic Cloud', 280.47, -32.89, 0.0496, 'spiral', 7000, 35, 1, 0.7],
  ['Small Magellanic Cloud', 302.8, -44.3, 0.0619, 'irregular', 3500, 60, 1, 0.5],
  ["Bode's Galaxy (M81)", 142.09, 40.9, 3.63, 'spiral', 45000, 59, 2, 1.1],
  ['Cigar Galaxy (M82)', 141.41, 40.57, 3.53, 'spiral', 18500, 80, 2, 0.9],
  ['Centaurus A', 309.52, 19.42, 3.8, 'elliptical', 30000, 40, 0, 1.2],
  ['Pinwheel Galaxy (M101)', 102.04, 59.77, 6.4, 'spiral', 85000, 18, 4, 1.1],
  ['Whirlpool Galaxy (M51)', 104.85, 68.56, 8.6, 'spiral', 38000, 20, 2, 1.1],
  ['Sombrero Galaxy (M104)', 298.46, 51.15, 9.55, 'spiral', 25000, 84, 2, 1.2],
  ['Messier 87', 283.78, 74.49, 16.4, 'elliptical', 60000, 30, 0, 3],
]

export const REAL_GALAXIES = GALAXIES.map(([name, l, b, mpc, type, R, inc, arms, lum], k) => {
  const pos = fromLB(l, b, mpc * MPC)
  const v = pos.map(x => x / (mpc * MPC))
  // tilt the normal away from the line of sight by the inclination
  const up = [0, 0, 1], dv = up[0] * v[0] + up[1] * v[1] + up[2] * v[2]
  let w = [up[0] - dv * v[0], up[1] - dv * v[1], up[2] - dv * v[2]]
  const wl = Math.hypot(...w); w = w.map(x => x / wl)
  const ci = Math.cos(inc * deg), si = Math.sin(inc * deg)
  const normal = [0, 1, 2].map(j => -v[j] * ci + w[j] * si)
  return {
    id: 'real-' + k, name, real: true, type: type === 'irregular' ? 'spiral' : type, R, arms: Math.max(arms, 1),
    pitch: (type === 'irregular' ? 30 : 14) * deg, phase: k, hR: R / 4.5, hz: R / 60, bulge: R * 0.08,
    bar: type === 'irregular' ? R * 0.4 : R * 0.15, barAngle: k, seed: 101 + k, lum, pos, normal, tint: [1, 1, 1],
  }
})

// Sagittarius A*: 4.3 million solar masses, Schwarzschild radius ~1.27e10 m
export const SGR_A = { name: 'Sagittarius A*', radius: 1.27e10 }
