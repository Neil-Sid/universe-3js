# Deep-sky objects and the Milky Way's real arms

## Milky Way structure (galaxy.js, catalog.js `MILKY_WAY`)

- `MILKY_WAY.armTable` holds the log-spiral fits from Reid et al. 2019 (ApJ 885, 131, Table 2; R0 = 8.15 kpc, rescaled so R0 lands on the Sun's 26,670 ly). The arms are Scutum-Centaurus(-OSC) and Perseus (major), Sagittarius-Carina and Norma-Outer (minor), and the Local Spur. Each arm is a kink `[beta, R]` plus `[from, to, pitch]` segments in Galactocentric azimuth. Past the parallax data the segments follow the paper's 4-arm extrapolation: Norma wraps behind the centre into the Outer arm, Scutum-Centaurus into the OSC, Sagittarius-Carina drops to a 10 deg pitch past its tangent, and Perseus runs in toward the far end of the bar.
- Frame: galaxy-local, with the centre at the origin, the Sun at (-26670, 0, +21), and y toward l = 90. Azimuth is `beta = atan2(y, -x)`, and an arm point is `(-R cos beta, R sin beta)`.
- Checks: the tangent longitudes come out at Sct-Cen 306.3 (paper 306.1), Sgr-Car 285.9 (285.6), Scutum 32.8 and Sagittarius 47.5. The Sun sits between Sgr-Car (1.3 kpc inside) and Perseus (2 kpc outside), about 0.4 kpc inside the Local Spur's centreline.
- `armProfile(g, x, y, field)` dispatches to `realArmProfile` when `g.armTable` exists. Other galaxies keep the generic arms. `field` is `'old'` (density, old disk) or `'young'`. Arm width is Reid's Gaussian sigma growing 42 pc per kpc, times `OLD_WIDEN` = 1.7. Arm ends taper over about 30 deg.
- `density()` for the MW is normalised so the solar neighbourhood stays at 1. It adds `barDensity`: the long bar, half-length 16,300 ly (5 kpc), at `barAngle` -27 deg, which puts the near end at positive longitude.
- `buildCloud` for the MW does the following:
  - places its knots with `realKnots`, using `armSample`, which is weighted by star formation (R e^-R/hR) and the young weights
  - uses a flat-topped thin bar (13% of particles) and a smaller bulge (5%)
  - thins the old disk inside the bar radius
- Look down from above with `uni.jumpLy(26670,0,75000); uni.lookDir(0,0,-1)` (Sun at top, l = 90 to the right, same orientation as Reid's Fig. 1). See shots/dso-mwtop3.png.

## Deep-sky objects (js/deepsky.js)

- `DEEP_SKY` holds 18 real objects: name, type, RA/Dec, distance, radius, card facts and a builder. Each builder works in sky axes as in a north-up photo (x west, y north, z away from Earth, in ly). `Builder` converts these to galactic axes using `skyAxes(ra, dec)`. `b.sky(ra, dec, ly)` places sub-objects by their own coordinates (the Pleiades sisters, the Hyades giants, h and chi Persei).
- Point generators: `cloud`, `shell`, `path`, `torus`, `king`, plus `wispy` (ridged fbm3 acceptance, so blobs fall on sheets that read as wisps).
- Populations: `young` (a Salpeter IMF between mass bounds) and `oldStar` (turnoff, red giant branch, horizontal branch, blue stragglers).
- Rendering: `gasSprites` is a TSL instanced billboard in the style of blobSprites, and comes in two kinds:
  - emission (additive)
  - dust (normal blending, dark)
  Blobs keep their surface brightness while resolved and fade as unresolved points. Each blob fades once it is bigger than `maxPx` on screen (80 px for gas, 60 px for dust), or once the camera is inside it. That bounds overdraw: smaller blobs take over up close. Per-blob `mx_noise_float` mottling, seeded from the blob position, breaks up the gaussian look. Stars use `starSprites` (gain 100, as for streamed stars).
- Each object is its own `THREE.Group`, with instance positions local to the object, so float32 precision holds up close. `DeepSky.place(cam)` does the following each frame:
  - positions every group camera-relative
  - fades the whole set by distance from the MW centre (full inside 1.5 R, gone at 3 R)
  - sorts objects back to front by `renderOrder`
  - puts each object's dust in front of or behind its glow, depending on which side the camera is on (dust is split at build time into near/far halves by sky z)
- Globulars also get one integrated-light star point (`b.glowL`, L of about 1e5 to 1e6), hidden within 12 radii. Without it they vanish from Earth, because no single giant is above the star-sprite cutoff at 10-20 kly.
- Arm field: the `field` object holds 260 procedural HII regions (Hα blobs plus 2-7 O stars) and 180 young clusters. They are seeded (`hash(77)`), drawn with `armSample`, kept more than 2,500 ly from the Sun, and anchored at the Sun. They are not selectable.
- The Carina Nebula is placed at 7,500 ly, centred on Eta Carinae (the catalogue's 7,500 ly), not at 8,500 ly, so the star sits inside its nebula.

## Hooks in shared files

- main.js:
  - imports and creates `this.deepsky = new DeepSky(galaxyScene)` after the catalogue stars
  - calls `this.deepsky.place(cam)` in `place()`
  - has a `dsoTarget(o)`: kind `'deepsky'`, standoff 2.6 radii, arriving on the Earth-facing side (`o.sunward`)
  - in `pick()`, has a deep-sky pass: hit anywhere on the patch, score 40, skipped once the object is bigger than 0.6 of the screen height, so stars inside it stay clickable
  - in `find()`, falls back to `this.deepsky.find(name)`, which matches the full name, the short name ("orion nebula") or the alias ("m42")
- ui.js:
  - adds a 'Nebulae & clusters' destinations section (`DEEP_SKY_NAMES`, which also feeds search)
  - adds a `'deepsky'` card kind (type, distance from Earth, diameter, facts)
  - labels deep-sky objects with class `dso` while 0.012 < angular radius < 0.8 rad (skipping the selected one)
  - in `place()`, shows the object's name plus "inside the <type>" when the camera is within its radius (`deepsky.around()`)
- sprites.js: `quadGeometry`, `billboard` and `spriteMesh` are now exported. No behaviour change.
- css/style.css: `.lbl.dso` colour.

## Open issues / ideas

- The arrival camera keeps its own roll, so objects are not shown celestial-north-up as in photographs. The Horsehead appears on its side. The fix needs a roll target in flight.js `runAuto`.
- Nebula looks are procedural approximations: Orion, Crab, Ring, Helix, Rosette and Carina read well. Eagle and Lagoon are plausible but generic.
- When very close (under ~10 ly), large dust blobs fade with the maxPx guard, so big dark clouds (L1630, the Carina V) thin out up close. More small dust blobs would fix this, at an overdraw cost.
- The procedural HII field is faint from outside the galaxy (physically fair, but external spiral photos show pink knots). If wanted, raise `armField` lum, or add a few giant HII complexes.
- Not done: the 3-kpc arms (the bar hides them). Deep-sky objects are not wired into star-system entering, so cluster stars are visual only and you cannot enter their systems.
- fps in the headless harness is about 37-43 everywhere (at Earth, inside Orion, inside Omega Centauri, inside Carina), with or without the deep-sky set. That is the same as the baseline within noise, and other agents were using the GPU at the same time.
