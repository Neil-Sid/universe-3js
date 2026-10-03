# Terrain (landing on rocky worlds)

`js/terrain.js` swaps a landable body's sphere for a cube-sphere quadtree when the camera is within
3.6 radii of its centre (back to the sphere above 4.0). It works on every `look.mode === 0` planet or moon:
Earth, the Moon, Mars, Mercury, Phobos, procedural moons and generated worlds. Banded worlds are not
landable (gas giants, ice giants, Venus, Titan) and keep the old minimum altitude.

## How it works
- **Quadtree.** The patch is 64×64 with skirts, ported from Terra. Leaves split while closer than 2.1 patch
  edges, down to a ~0.25 m vertex spacing (`maxLevel` per body). There is horizon culling and a frustum test
  in the body frame (a stack of spheres per patch). It uses at most 4096 instances, typically 40 from orbit
  and 300–700 at the ground. CPU cost is ~0.3 ms per frame.
- **Precision.** Per instance, `iCube` is the cube centre and size; `iRel` is the sea-level patch centre
  minus the camera, in km, body frame, computed in float64. The GPU adds small offsets, then rotates by
  `U.rot` (the body's orientation). The mesh sits at the scene origin with an identity transform, and
  nothing large reaches the GPU.
- **Height field:** one TSL function (`reliefNode`) with one call site in the vertex stage and one in the
  fragment stage. It mirrors the CPU code exactly.
  - **Continental relief (`macro`)**, in km:
    - Earth: a 16-tap cubic B-spline of the bump (R) and land (G) channels of
      `earth_bump_roughness_clouds_4096.jpg`, `h = 6 km · R^1.7`, oceans flat at 0.
    - Moon: the albedo brightness, so the maria sit low.
    - Others: the planet shader's own `mx_fractal_noise_float` field, so the coastlines and highlands seen
      from orbit are where the relief is. Seas sit at `look.sea`.
    - The elevation maps are decoded once on the CPU (`createImageBitmap`) and uploaded as DataTextures,
      so the CPU and GPU read the same bytes through `textureLoad`.
  - **Octave ladder:** wavelength `λ_i = lam0 / 2^i`.
    - Gradient noise with analytic derivatives, plus ridges (a soft `|n|`, faded out below ~1 km) and
      erosion damping by the accumulated slope.
    - Amplitude: a power law (gain 0.62, then 0.52 in the camera-relative octaves). Earth and worlds with
      atmospheres instead peak at ~20–30 km (`peak`), because the coarse shape comes from the map or the
      fbm.
    - Octaves coarser than 256 m are evaluated on the unit direction, each with one of 4 fixed rotations.
      Finer ones use a 256-periodic lattice in metres, offset by `U.off[k] = mod(camera / λ, 256)`, which is
      reduced in float64 every frame. That keeps them exact down to ~2 mm.
  - **Craters:** one 3D lattice per octave (cell = 2λ).
    - The centre sits on the surface plane through the cell, and the crater shrinks to fit inside its cell,
      so no neighbour lookups are needed.
    - The profile is a bowl, a C1 Hermite rim, an apron, and a flat floor for craters over ~15 km.
    - Each crater fades in by its own radius against the band limit, so small ones never alias.
    - Density follows the maria on the Moon (craters over 5 km only).
  - **Band limits.** The geometry keeps wavelengths above `distance / 60` (never below 0.5 m). The fragment
    stage adds the band between that and 2 pixels, as normals only.
- **Shading:**
  - The same uniforms as the sphere (`b.u.sun / sunCol / light`). Terrain normals and a Lommel–Seeliger
    share on airless bodies fade in below 3.6R (`U.relief`), so the switch is seamless (checked:
    `land-switch-moon-*`).
  - Mapped looks sample the day map at a mip level from `dFdx/dFdy` of the direction (no seam, no grazing
    aliasing). The terrain applies `look.sat`, `look.gain` and `look.lon0` like `materials.js`.
  - Procedural looks repeat the mode-0 colour code of `materials.js planetMaterial`. **Keep the two in sync.**
  - Earth: map snow turns to rock below a snowline / on cliffs up close. Clouds and the land/sea mismatch
    near coasts are handled. Clouds fade out from 300 km to 30 km altitude.
- **Atmosphere:** the last line of `terrainMaterial` is the atmosphere agent's
  `if (b.air) mat.colorNode = b.air.surface(mat.colorNode)`. Keep exactly one such call.

## Hooks in shared files (small)
- `system.js`: `System.orient(b, q)`, the body orientation at the current time, factored out of `place()`.
- `main.js`:
  - Constructs `new Terrain(system scene, renderer)`.
  - `terrain.update(...)` runs after `system.place`.
  - `surf` and `collide` use `terrain.ground(system, b, pos)`, the ground radius in m, or null when not
    landable or not ready. Clearance is 1.8 m.
  - `World.corotate(f)`.
- `flight.js`: `world.corotate?.(this)` at the top of `update`. Near a body with active terrain, the camera
  turns with the body's spin, so the ground holds still (Earth's surface moves at 465 m/s otherwise).
- `ui.js`: the header altitude is measured above the terrain.
- `materials.js`: `map()` is exported.
- `upos.js`: **CELL is now 2^40 m (was 2^50).** Offsets near 2^50 m only resolve to 0.25 m. Anything at
  negative coordinates (half the Solar System) was rounded every frame, so the camera drifted 2–3 m/s on the
  Moon and jittered near the ground. With 2^40 m, the precision is ~0.2 mm and the cell index stays exact
  far past the observable universe. Nothing else depended on CELL.

## Test helpers
- `shots/land.js` (pre-script):
  - `orbitAt(name, radii)`
  - `landLL(name, lat, lon | null, altM, pitch, heading)`: `lon = null` means morning light.
  - `landAt`, `findLand(name, minKm)`, `goStar(x, y, z, starName)`, `pickRocky()`
  - `drift(name, s)`: body-frame camera drift; should be 0.
  - `altInfo()`
- `shots/land-seq.cjs`: `LAND_BODY=Mars LAND_LAT=15 node tools/check.cjs steps:shots/land-seq.cjs` shoots
  orbit, 100 km, 2 km and 10 m.
- `shots/hprobe.js`: `hProbe(limM)` runs the GPU height in a compute pass and compares it with `heightAt`.
  They agree to ~0.1 m. `shots/mxprobe.js` checks the MaterialX port. Both use `terrain.js _probe`.
- `uni.terrain.P.gpu.U.debug.value = 1` shows normals, `2` shows albedo.

## Numbers
- Pipeline compile (async, `compileAsync`, started below 14R): 0.2–2 s per body, so there is no frame hitch.
- fps: no measurable difference with the terrain mesh hidden or shown (the headless harness sat at ~42 fps
  either way, with other agents on the GPU).

## Open issues
- No cast shadows: crater floors at low sun are lit by their own normals only. A horizon map or a ray march
  of the CPU height would fix it.
- The sea is a flat surface with a sun glint: no waves, Fresnel or sky reflection yet. Earth's bathymetry is
  not used.
- Earth colour up close is the 10 km/px Blue Marble map, plus rock/snow rules. There is no vegetation or
  biome detail, and coasts near the map's own coastline show a fill colour.
- Sub-pixel normal aliasing (dark specks) on very rough small bodies seen from far away (Phobos from 13 km).
- Mars has no real altimetry: the threex `marsbump1k` is shading, not elevation (Hellas comes out high), so
  Mars relief is procedural.
- With time warp the co-rotation keeps you on the ground, but the autopilot (`goTo`) still works in the
  inertial frame.
