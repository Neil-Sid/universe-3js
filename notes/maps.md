# Real texture maps for Solar System planets and rings

## What changed

- **looks.js**: Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune and Pluto now have `maps.day`. Maps load at runtime from
  `cdn.jsdelivr.net/gh/jeromeetienne/threex.planets@master/images/` (Planet Pixel Emporium maps, served with CORS). Every
  entry keeps its procedural fields (`cols`, `bands`, ...), which are used if a map fails to load. New optional look fields:
  - `maps.bump` + `bump` (strength): a height map used for relief shading. Only Mars has one (`marsbump1k.jpg`, strength 3).
  - `lon0`: the u of longitude 0 in the image. The default is 0.5, as in a centred map. Mars uses `lon0: 0` because its map starts at 0°E, which puts the prime meridian at +X like Earth's.
  - `sat`, `gain`: these desaturate or darken an over-coloured map. Mercury's PPE map is a fake orange colourisation, so it uses `sat 0.3, gain 0.65`.
  - `ringMaps: { color, alpha, opacity?, gain? }`: Saturn (`saturnringcolor.jpg` + `saturnringpattern.gif`) and Uranus
    (`uranusringcolour.jpg` + `uranusringtrans.gif`, opacity 0.35).
- **materials.js** (mapped and ring parts):
  - The `map()` cache sets the textures it is given to wrap in longitude. It records load errors and announces each one as an event whose type is the URL.
  - `withFallback(mat, urls, mapped, fallback)` returns one stable `Fn` node that builds `mapped()`, or `fallback()` once any of its URLs has failed. When a load fails, it sets `mat.mapsDown = 1`, which changes three's program cache key, and `needsUpdate` then forces a rebuild. Because the node object never changes, wrappers placed around `mat.colorNode` survive the swap, such as the atmosphere agent's `body.air.surface(mat.colorNode)` in system.js. This was tested by redirecting Saturn's URLs to 404s: you get procedural bands, procedural rings and the atmosphere rim, with no errors besides the 404s.
  - `planetMaterial(look, seed, u?)`: a mapped look passes `() => planetMaterial({ ...look, maps: null }, seed, u).mat.colorNode` as its fallback. This reuses the same uniforms.
  - `surface()` samples planet maps with the `lon0` offset. `bumped()` tilts the normal by the height map's gradient along east/north in object space, then transforms it with `modelWorldMatrix`.
  - `ringMaterial(..., tex)` takes an optional sixth argument for the colour and alpha strips. The planet-shadow term is unchanged and the procedural rings are unchanged.

## Hooks in shared files

- `js/system.js`, in `addBody`: `ringMaterial(ri, ro, seed % 13, center, b.radius / KM, look.ringMaps)`. Only the last argument was added.

## Orientation checks

- three's SphereGeometry puts u = 0.5 at +X, and u grows toward -Z, which is east for a prograde spin about +Y. Image top is north (+Y). Earth was already validated this way, and the other maps use the same path.
- Screenshots confirm it: Mars's Hellas basin, Jupiter's Great Red Spot and Neptune's Great Dark Spot all sit in the south, and Tharsis lies west of Valles Marineris. Nothing is mirrored or upside down.
- Ring strips run from the **outer edge (left) inwards**, not the inner edge. This was confirmed against Saturn's gaps: Keeler at 0.054, Encke at 0.095, Huygens at 0.335 and Maxwell at 0.802 from the left all match their real radii over the 74,500 to 140,220 km span. So the shader samples `u = 1 - (r - inner)/(outer - inner)`. The pattern's grey value is the opacity: the B ring is the most opaque, the C ring is faint.

## Open issues

- Mercury's and Pluto's PPE maps are artistic, pre-MESSENGER and pre-New Horizons. Uranus's map is nearly featureless.
- The Saturn ring colour strip tints the B ring slightly grey-blue. That comes from the source image.
- Real-longitude phase is only modelled for Earth. Other planets spin from an arbitrary phase, so `lon0` only fixes the convention.
- Planets get no ring shadow (only rings get the planet's shadow).
