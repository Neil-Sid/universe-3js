# Atmospheres

`js/atmosphere.js` replaces the old additive rim glow (`atmosphereMaterial`, now removed from materials.js)
with single-scattering Rayleigh + Mie, marched per pixel.

## How it works

- **View ray:** 16 samples between the shell entry and exit (or the ground). They bunch up quadratically
  around the ray's closest approach to the planet, which is where the air is densest: at the tangent point
  for limb rays, near the camera from inside, and near the ground when looking down from space. Each
  segment is integrated exactly with `(1 - e^-x) / x`.
- **Sunlight at each sample** comes from an analytic Chapman column, with no inner loop or LUT. The formula
  is `exp(y²) erfc(y) ≈ 2 / (√π (y + √(y² + 4/π)))`, which is within 6% at every angle. When looking down,
  it uses the full chord minus the near part. The planet's shadow is a smoothstep at the geometric horizon.
  For aerosol sunlight extinction, the forward-scattered share (`mie·g`) is removed, a delta-scaling
  approximation. Without it, thick hazes like Titan's come out black.
- **Multiple scattering:** a cheap isotropic term (`MS`). Past the terminator, only air above the planet's
  shadow (height `R·e²/2`) stays lit. This produces twilight and blue hour, then real night.
- **Phases:** Rayleigh, plus Cornette-Shanks for aerosols with a per-channel `g`. On Mars, blue scatters
  forward and red scatters wide, which gives a butterscotch day sky and a blue glow around the setting sun.
- **Precision:** the camera's distance from the centre, `camR`, is a uniform fed from `body.dist`, which is
  float64 on the CPU. Ray-sphere tests use the factored form `b² − (camR−r)(camR+r)`, so the horizon is
  exact at 2 m altitude. The ray origin is `-normalize(center) · camR`. Directions come from
  camera-relative `positionWorld`. Nothing large is subtracted on the GPU except at sub-pixel sizes.
- **Exposure:** `ADAPT` fades from 1 at the shell top to 2.2 at the ground. Air seen from inside glows
  brighter, like an eye adapting under a sky. From space the planet stays deep and the limb stays thin.

## The two pieces per body

1. **Sky shell.** A back-faced sphere (64×32), scaled to `(R + top) / 0.995` so its facets sit outside the
   analytic shell. Back faces lie behind the planet, so the shell never draws over the ground in any view. It
   gives the limb from space and the whole sky from inside, and no side switching is needed. It is drawn as
   premultiplied alpha: `sky + background · (1 − a)`.
   - `a = max(1 − mean(T), 0.92 · smoothstep(sky luminance))`. A bright day sky hides the stars, and they come
     back at dusk.
   - The same alpha dims the sun mesh, so the shell redraws the sun's disk through the air (`DISK · T`). The
     sun goes orange at sunset and vanishes behind the Martian dust.
2. **Aerial perspective** on the ground: `surface(colorNode)` / `apply(col, pos)`.
   - Haze is in-scattered between the camera and the surface point. The ray stops at the true sphere where
     the mesh facets dip below it.
   - The surface colour is also tinted by sunlight transmittance, relative to the overhead sun plus a little
     skylight. This gives golden ground near the terminator and leaves the day side neutral. Night lights are
     untouched.

## API (for terrain and other surfaces)

```js
import { atmosphere, airFor, AIR } from './atmosphere.js'
body.air = atmosphere(body, system.star)   // done in System.addBody when look.atmo is set
body.air.mesh                               // the sky shell (already added to body.group)
body.air.surface(vec4Node)                  // wraps a surface colorNode: aerial perspective + reddened sun
body.air.apply(vec3Col, worldPosKm)         // same, call inside a TSL Fn; worldPos = camera-relative km (positionWorld)
body.air.params / .R / .top                 // the air preset, planet radius and shell radius (km)
```

`atmosphere(body, star)` needs:
- `body.radius`, `body.look`, and `body.kind`
- `body.u.{sun, sunCol, light}` (the planet material's uniforms)
- `body.center` and `body.dist`, both updated each frame by `System.place`
- `star.radius` and `star.dist`

Uniforms update themselves through `onRenderUpdate`, so `place()` needs no extra hook.

## Air presets (`AIR`, km units)

- **Lookup:** Solar System bodies are keyed by look name (matched by identity in `LOOKS`). Generated
  bodies are keyed by kind.
- **Fallback:** anything else with `look.atmo` gets a generic haze tinted by `look.atmo`, with `atmoH` as
  its height.
- **Preset fields:**
  - `top`: shell height
  - `hR` / `hM`: scale heights
  - `ray`: Rayleigh scattering at the surface
  - `mie` / `abs`: aerosol scattering and absorption (rgb)
  - `g`: aerosol asymmetry (rgb)

| key | notes |
| --- | --- |
| earth / ocean | Rayleigh 5.8/13.6/33.1e-3 per km, H 8 km, top 100 km; aerosol 0.008 per km, H 1.2 km, g 0.76 |
| tundra, waterworld, arid | Earth-like with a thinner scale height / humid haze / dust |
| mars / marslike | Rayleigh ×0.02, H 11 km; dust optical depth ~0.5, red scatters, blue absorbed, g 0.6/0.68/0.82 |
| desert | thin, dusty |
| venus | sphere = cloud deck; yellow-white sulphuric haze above it (H 5 km), weak Rayleigh |
| titan / hazy | top 500 km, orange tholin haze (H 70 km) that absorbs blue; from space the limb shows the blue Rayleigh fringe |
| jupiter, saturn, gas | very subtle warm limb haze (H 27 / 60 / 30 km) |
| uranus, neptune, icegiant | slight blue limb |
| subneptune | pale blue-grey haze |
| hotjupiter | puffy (H 120 km), warm haze |

## Changes outside atmosphere.js

All of these are one-line, surgical edits:
- **system.js:**
  - Imports `atmosphere`. `addBody` creates `body.air`, wraps the planet colorNode and adds the shell. This
    replaced the old `atmosphereMaterial` block.
  - In `addStar`, the star glow sprite now has `depthTest = true`. Before this, the Sun's glow showed through
    the planet: a bright blob under the ground at night, and through the night side from space.
- **materials.js:** removed the dead `atmosphereMaterial`.
- **main.js:** the bloom high-pass gets a soft knee (`smoothWidth = 2`). Three's BloomNode passes the whole
  pixel once it crosses the threshold, so smooth sunset skies showed a hard-edged "tent" where they crossed
  1.1.
- **terrain.js:** `if (b.air) mat.colorNode = b.air.surface(mat.colorNode)` at the end of the terrain
  material, so landed and near-orbit views get haze. **Landing agent:** don't add a second
  `apply`/`surface` call. That would double the haze.

## Testing

- **`shots/atmo.js`:** `skyView(body, altKm, sunElevDeg, azFromSunDeg, pitchDeg)` stands the camera at a spot
  with a given sun elevation and pauses time.
- **`shots/atmo-bodies.cjs`:** steps for Mars, Venus, Jupiter, Saturn, Neptune and Titan, from space and from
  the surface. Filter with `ONLY=Mars,Titan`.
- **`shots/atmo-kinds.js`:** `atmoKind(kind, seed)` dresses Earth as a generated kind, with its air.

Examples:

```
node tools/check.cjs "pre:shots/earthview.js" "wait:6" "js:return earthView(3.2)" "wait:2" "shot:atmo-earth.png"
node tools/check.cjs "pre:shots/atmo.js" "wait:6" "js:return skyView('Earth', 0.002, 4, 10, 2)" "wait:3" "shot:atmo-ground-sunset.png"
node tools/check.cjs "pre:shots/atmo.js" "steps:shots/atmo-bodies.cjs"
```

**Cost:** headless fps was the same with and without the shells (the frame-pacing limit).
- Inside the atmosphere the sky costs 16 samples per pixel, each with 4 Chapman columns, over the full screen.
- The ground pays the same once more.

## Open issues / ideas

- Single scattering plus an isotropic term underestimates very thick atmospheres. Venus below the clouds
  and Titan are tuned by eye, not by optical depth.
- No ozone. The zenith at twilight is slightly too grey rather than deep blue.
- Rings and moons do not cast shadows into the air. Eclipses do not dim the sky.
- `ADAPT` is a fixed altitude-driven gain, not real auto-exposure. Bright sunsets near the sun still clip
  (bloom is now smooth).
- The backlit sunset ring around the night-side limb only appears from far away (more than about 10 R),
  where the limb is the terminator. That is physically right, but it is a few pixels wide at that distance.
- A daytime Moon is dimmed by the 0.92 star hiding together with the stars. Lower `HIDE` if that matters
  more than stars by day.
