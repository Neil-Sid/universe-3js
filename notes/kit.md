# agent-kit on Continuum (2026-10-03)

The shared toolkit is `../agent-kit`, next to this repo (see its AGENTS.md). Config: `kit.config.mjs`. Scenarios:
`earth` (the start view), `saturn`, `orion` and `web` (the cosmic web). Each scenario ends its trip in the first frame and
then streams during the warm-up. Results go in `.kit/`, which is gitignored.

```
node ../agent-kit/bin/kit.mjs perf earth
node ../agent-kit/bin/kit.mjs lint
```

## Fix: sprite buffers re-sent every frame
`js/sprites.js quadGeometry()` set every instance attribute to `DynamicDrawUsage`. three's WebGPURenderer re-uploads a
dynamic attribute in full on every draw, whether or not it changed (`three.webgpu.js` Attributes.update:
`data.version < version || usage === DynamicDrawUsage`). That came to about 49 MB of `queue.writeBuffer` per frame,
roughly 8-12 ms of CPU. I confirmed it without the kit too. The attributes now keep static usage, and `upload()` already
bumps the version when the data changes.

| scenario | before | after |
|---|---|---|
| earth | 70 fps, p50 13.8 ms | 582 fps, p50 1.5 ms |
| saturn | 71 fps | 391 fps |
| orion | 73 fps | 440 fps |
| web | 110 fps | 443 fps |

1920x1080, headless, uncapped. Orion and web simulated identical frames before and after. The cosmic-web screenshots
before and after the change look identical, and Orion matches docs/orion.jpg.

## Still open
- `Cosmos.update` (js/cosmos.js:193) runs every frame even at Earth: about 0.7-1.4 ms and 550 KB/frame of
  allocation, mostly cell-key strings and the `want` scan. It is now the biggest project cost.
- `terrain.js` iCube/iRel are still `DynamicDrawUsage`. That's harmless because they change every frame (124 KB/frame).

## Fix: lag when clicking a system or zooming out (2026-10-03)
The user reported lag every time they clicked a new system or started zooming out from the Solar System. I reproduced it with the
`visit` scenario (select and fly to Sirius, then Vega) and the `zoomout` scenario (a wheel notch every other frame from
Earth). `kit perf <s> --hitches` re-ran each worst frame and profiled it.

Causes and fixes:
- **Shader compiles on first draw.** Arriving at a system stalled 0.4-7.9 s in WebGPU `submit`, and the first draw of
  the cosmic web and galaxy layers on zoom-out stalled 0.25-0.5 s. Fix: `World.warm(object, layer)` in main.js runs
  `compileAsync` into the HDR target, hidden objects included. It runs for every layer at boot, behind the loading
  screen. New systems and GalaxyClouds now stay hidden until their pipelines are ready (a short delay on arrival).
- **Cosmic-web repack.** `Cosmos` re-packed up to 420k galaxies in one 50-300 ms frame every time the camera crossed a
  24 Mpc cell. Fix: it is skipped while the web is hidden inside a galaxy, and otherwise runs as a generator
  (`packing()`), 3 ms a frame. The old buffers stay on screen until the new pack swaps in with its anchor.

| scenario | worst frame | p99 | frames > 16.7 ms |
|---|---|---|---|
| visit, before | 7897 ms | 12.5 ms | 16 |
| visit, after | 17.7 ms | 8.4 ms | 1 |
| zoomout, before | 520 ms | 59.5 ms | 57 |
| zoomout, after | 21.8 ms | 17 ms | 9 |

What's left: ~20 ms frames from star-level streaming (`StarLevel.update`/`merge` allocates and re-merges every cell).

## Fix: planets invisible for a moment on a new system (2026-10-03, follow-up)
The first fix hid each new system until its shaders compiled: 1.9 s at Sirius, 5.1 s at Vega. Every planet compiled its own
pipelines (15-25 per system), because materials baked per-planet numbers into the shader code. Leaving a system also
disposed them, so nothing was ever reused.
- materials.js `lookUniforms()`, plus the ring and atmosphere.js parameters, are now uniforms. Shader code depends only
  on a look's features (variantOf in system.js).
- system.js shader library: on leaving a system, the first object of each variant not seen before is kept (hidden,
  never disposed), so three keeps its pipeline cached.
- main.js builds a throwaway system with one planet of every generated variant (`variantsSpec`) during boot. It
  compiles in the background after boot (`warmVariants`, about 5.5 s) and is then disposed into the library.
  `warmGroups` compiles one planet per frame.
- Result: planets show 75-125 ms after entering a system, with no new pipeline compiles. `visit` worst frame is 18.7 ms
  and `zoomout` is 22.6 ms. Boot is 1.95 s originally, 2.4-2.7 s now. Startup was originally a 1.3 s freeze followed by
  25-75 ms frames; now it is 2-3 frames of 100-150 ms while the background compile starts.
- Pixel A/B with the gallery (gas, ocean, frozen, lava, icegiant): mean difference under 1/255.
- kit.config `ready` waits for `uni.variants` to clear, so scenarios start after the background warm-up.
