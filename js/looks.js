// Surface looks for planets and moons: plain data consumed by the TSL planet shader.
// mode 0 = rocky/terrain (fbm heights, craters, seas, caps), mode 1 = banded (gas and ice giants).
const hex = h => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255].map(c => c ** 2.2)

const MAPS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets/'
const TX = 'https://cdn.jsdelivr.net/gh/jeromeetienne/threex.planets@master/images/'   // Planet Pixel Emporium maps
const day = (f, more) => ({ maps: { day: TX + f, ...more } })
const base = { cracks: 0, glow: 0, haze: 0, mode: 0, freq: 2.2, sea: -1, seaCol: 0x0a1f3c, cap: 0, craters: 0, clouds: 0, lava: 0, bands: 0, turb: 0, atmo: null, atmoH: 0.02, spot: 0 }
const L = o => ({ ...base, ...o })

export const LOOKS = {
  // Real maps where available (NASA Blue Marble / city lights / LRO via the three.js examples, the rest via
  // threex.planets). The procedural fields stay as the fallback if a map fails to load.
  earth: L({ maps: { day: MAPS + 'earth_day_4096.jpg', night: MAPS + 'earth_night_4096.jpg', brc: MAPS + 'earth_bump_roughness_clouds_4096.jpg' }, cols: [0x1d3a12, 0x4a5a2a, 0x8a7550, 0xe8e8e8], atmo: 0x5d8ee8 }),
  mars: L({ ...day('marsmap1k.jpg', { bump: TX + 'marsbump1k.jpg' }), bump: 3, lon0: 0, cols: [0x5a2410, 0x94482a, 0xc07a4a, 0xd9a276], cap: 0.9, craters: 0.35, atmo: 0xc98a60, atmoH: 0.012 }),
  mercury: L({ ...day('mercurymap.jpg'), sat: 0.3, gain: 0.65, cols: [0x3a3632, 0x6b6560, 0x8f8a84, 0xaaa49e], craters: 1, freq: 3 }),
  venus: L({ ...day('venusmap.jpg'), mode: 1, cols: [0xd8c79a, 0xe8dcb8, 0xc9b27a, 0xf0e6c8], bands: 5, turb: 3.5, atmo: 0xf2dca0, atmoH: 0.03 }),
  moon: L({ maps: { day: MAPS + 'moon_1024.jpg' }, cols: [0x2e2d2c, 0x5c5a57, 0x8a8783, 0xa9a6a2] }),
  jupiter: L({ ...day('jupitermap.jpg'), mode: 1, cols: [0xc9a57c, 0xf0e2c8, 0x8a5a3c, 0xb07850], bands: 22, turb: 2.2, spot: 1, atmo: 0xd8c8a8, atmoH: 0.01 }),
  saturn: L({ ...day('saturnmap.jpg'), ringMaps: { color: TX + 'saturnringcolor.jpg', alpha: TX + 'saturnringpattern.gif' }, mode: 1, cols: [0xd6bd88, 0xefe0b4, 0xb8975c, 0xcfb27a], bands: 18, turb: 1.2, atmo: 0xe8d8a8, atmoH: 0.01 }),
  uranus: L({ ...day('uranusmap.jpg'), ringMaps: { color: TX + 'uranusringcolour.jpg', alpha: TX + 'uranusringtrans.gif', opacity: 0.35 }, mode: 1, cols: [0x9fd6dc, 0xb8e6ea, 0x8cc8d2, 0xa8dce0], bands: 6, turb: 0.4, atmo: 0x9ce0f0, atmoH: 0.02 }),
  neptune: L({ ...day('neptunemap.jpg'), mode: 1, cols: [0x2f58c8, 0x4a78e0, 0x22409a, 0x6a90ec], bands: 9, turb: 1.4, spot: 0.6, atmo: 0x4a7af0, atmoH: 0.02 }),
  pluto: L({ ...day('plutomap1k.jpg'), cols: [0x6a4a36, 0xa88a6a, 0xd8c4a8, 0xf0e8e0], craters: 0.3, freq: 1.8 }),
  rock: L({ cols: [0x3a332c, 0x5e544a, 0x7e7266, 0x9a8e82], craters: 0.8 }),
  io: L({ cols: [0xb89a2a, 0xe0cc4a, 0xf2e89a, 0x8a4a1a], freq: 3, lava: 0.35 }),
  europa: L({ cols: [0xb0a08a, 0xd8ccb8, 0xefe8dc, 0x8a6a4a], freq: 5, craters: 0.1 }),
  ganymede: L({ cols: [0x4a4238, 0x7a7064, 0xa89e90, 0xc8c0b4], craters: 0.7, freq: 2 }),
  callisto: L({ cols: [0x2a2622, 0x4a433c, 0x6a625a, 0xb0a898], craters: 1, freq: 2.5 }),
  titan: L({ mode: 1, cols: [0xc88a3a, 0xd89a48, 0xb87a30, 0xe0aa58], bands: 3, turb: 1, atmo: 0xe0a050, atmoH: 0.08 }),
  triton: L({ cols: [0x9a8478, 0xc8b0a4, 0xe8d8d0, 0x7a6a64], cap: 0.4, freq: 2.4 }),
  iapetus: L({ cols: [0x1a1612, 0x3a322a, 0xd8d0c4, 0xf0ece4], freq: 0.7 }),
  ice: L({ cols: [0x8a8e94, 0xb8bcc2, 0xdcdfe4, 0xf4f6f8], craters: 0.6 }),
}

// Procedural looks for generated worlds. kind decides the family; the rng picks the palette.
const GAS_PALETTES = [
  [0xc9a57c, 0xf0e2c8, 0x8a5a3c, 0xb07850], [0xb8c4d8, 0xe4e8f0, 0x7a88a8, 0x9aa8c4], [0xd8b070, 0xf4dca8, 0xa87a3a, 0xc89858],
  [0xa87868, 0xe0c0b0, 0x704838, 0xc09080], [0x88a890, 0xd0e0c8, 0x5a7a60, 0xa0b890], [0xc0a0c8, 0xe8d8ec, 0x806090, 0xa888b8],
]
const ICE_PALETTES = [[0x7ab8d8, 0xa0d4e8, 0x5a98c0, 0x8cc4e0], [0x3a60c0, 0x5a80e0, 0x2a4498, 0x7098e8], [0x80c8b8, 0xa8e0d4, 0x60a898, 0x90d0c4]]
const ROCK_PALETTES = [
  [0x3a332c, 0x5e544a, 0x7e7266, 0x9a8e82], [0x4a2a1a, 0x7a4a30, 0xa87050, 0xc8986e], [0x2a2a2e, 0x4a4a52, 0x6e6e78, 0x9a9aa4],
  [0x5a4a32, 0x8a7652, 0xb49e76, 0xd4c29a],
]
const OCEAN_LAND = [[0x1d3a12, 0x4a5a2a, 0x8a7550, 0xe8e8e8], [0x3a2a18, 0x6a4a2a, 0x9a7a52, 0xe8e8e8], [0x123a2a, 0x2a5a48, 0x6a8a70, 0xe8f0f0]]

export function proceduralLook(kind, rng) {
  switch (kind) {
    case 'gas': return L({ mode: 1, cols: rng.pick(GAS_PALETTES), bands: rng.range(10, 26), turb: rng.range(0.8, 2.6), spot: rng.next() < 0.4 ? rng.range(0.4, 1) : 0, atmo: 0xd8d0c0, atmoH: 0.012 })
    case 'icegiant': return L({ mode: 1, cols: rng.pick(ICE_PALETTES), bands: rng.range(4, 10), turb: rng.range(0.3, 1.4), atmo: 0x88c8f0, atmoH: 0.02 })
    case 'ocean': return L({ cols: rng.pick(OCEAN_LAND), sea: rng.range(0.45, 0.6), seaCol: rng.pick([0x103a66, 0x0e4a70, 0x123858]), cap: rng.range(0.7, 0.9), clouds: rng.range(0.3, 0.7), atmo: rng.pick([0x5d8ee8, 0x6aa0d8, 0x8ab0e0]), freq: rng.range(1.6, 2.8) })
    case 'desert': return L({ cols: rng.pick(ROCK_PALETTES.slice(1)), cap: rng.next() < 0.5 ? 0.88 : 0, craters: rng.range(0, 0.4), atmo: rng.next() < 0.5 ? 0xd8a878 : null, atmoH: 0.012 })
    case 'venus': return L({ mode: 1, cols: [0xd8c79a, 0xe8dcb8, 0xc9b27a, 0xf0e6c8], bands: rng.range(3, 7), turb: rng.range(2, 4), atmo: 0xf2dca0, atmoH: 0.03 })
    case 'lava': return L({ cols: [0x1a1210, 0x2e2420, 0x44362e, 0x5a4a40], lava: rng.range(0.25, 0.6), freq: rng.range(2, 4) })
    case 'iceworld': return L({ ...LOOKS.ice, cap: 0, craters: rng.range(0.2, 1), freq: rng.range(1.5, 4) })
    case 'waterworld': return L({ cols: rng.pick(OCEAN_LAND), sea: rng.range(0.74, 0.82), seaCol: rng.pick([0x103a66, 0x0e4a70, 0x123858]), cap: rng.range(0.8, 0.92), clouds: rng.range(0.55, 0.8), atmo: rng.pick([0x5d8ee8, 0x6aa0d8]), freq: rng.range(1.8, 3) })
    case 'arid': return L({ cols: rng.pick([[0x4a3a22, 0x7a6038, 0xb09060, 0xe0d0a8], [0x3a3a20, 0x6a6a38, 0xa09868, 0xe0dcc0]]), sea: rng.range(0.3, 0.37), seaCol: 0x124a6a, cap: 0.9, clouds: rng.range(0.1, 0.3), atmo: 0x88a8d8, freq: rng.range(1.6, 2.6) })
    case 'marslike': return L({ cols: rng.pick([[0x5a2410, 0x94482a, 0xc07a4a, 0xd9a276], [0x4a3024, 0x7a5a44, 0xa88468, 0xc8ac90], [0x3a2a2a, 0x6a4a40, 0x9a7060, 0xb89a88]]), cap: rng.range(0.8, 0.9), craters: rng.range(0.2, 0.5), atmo: 0xc98a60, atmoH: 0.01 })
    case 'tundra': return L({ cols: [0x2e3428, 0x4e5440, 0x7e8070, 0xdde2e8], sea: rng.range(0.38, 0.46), seaCol: 0x10304a, cap: rng.range(0.45, 0.6), clouds: rng.range(0.35, 0.6), atmo: 0x8ab0e0, freq: rng.range(1.8, 2.8) })
    case 'frozen': return L({ cols: rng.pick([[0xa89c8c, 0xcfc6b8, 0xece6dc, 0xbcb0a0], [0x9cacbc, 0xc4d0dc, 0xe8eef4, 0xb0bccc]]), cracks: 1, craters: rng.range(0, 0.3), freq: rng.range(2.5, 5) })
    case 'hotjupiter': return L({ mode: 1, cols: rng.pick([[0x3a2418, 0x6a3a24, 0x24140c, 0x8a5030], [0x2a2430, 0x4a3a50, 0x1a1420, 0x6a4a60]]), bands: rng.range(6, 14), turb: rng.range(1.5, 3), glow: rng.range(0.5, 1), atmo: 0xff9050, atmoH: 0.02 })
    case 'subneptune': return L({ mode: 1, cols: rng.pick([[0x8aa8b8, 0xa8c0cc, 0x7898a8, 0x98b4c0], [0x9ab4a8, 0xb8ccc0, 0x80a090, 0xa8c0b4], [0xa8a8c0, 0xc4c4d8, 0x8c8ca8, 0xb4b4cc]]), bands: rng.range(3, 8), turb: rng.range(0.3, 1), haze: rng.range(0.12, 0.35), atmo: 0xa8c8e8, atmoH: 0.03 })
    case 'volcanic': return L({ ...LOOKS.io, lava: rng.range(0.08, 0.18), freq: rng.range(2.5, 4) })
    case 'hazy': return L({ ...LOOKS.titan, bands: rng.range(2, 4) })
    default: return L({ cols: rng.pick(ROCK_PALETTES), craters: rng.range(0.3, 1), freq: rng.range(1.5, 3.5) })
  }
}

export const toLinear = hex
