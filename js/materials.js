// TSL materials for resolved bodies (system layer, units km). Shading is procedural or from real maps: the
// pattern is evaluated on the object-space normal so it turns with the body, lighting comes from a
// per-body sun direction uniform in world space (world space here is camera-relative).
import * as THREE from 'three/webgpu'
import {
  Fn, uniform, vec3, vec4, float, normalLocal, normalWorld, positionWorld, positionLocal, normalize, dot, max, mix, smoothstep, pow,
  abs, length, sin, atan, reflect, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float, time, select, texture, uv, clamp,
  vec2, cross, modelWorldMatrix,
} from 'three/tsl'
import { toLinear } from './looks.js'

const loader = new THREE.TextureLoader()
const maps = new Map(), failed = new Set(), loads = new THREE.EventDispatcher()
// Cached texture. A load error is remembered and announced (event type = url) so materials can fall back.
export function map(url, srgb, wrap = false) {
  if (!maps.has(url)) {
    const t = loader.load(url, undefined, undefined, () => { failed.add(url); loads.dispatchEvent({ type: url }) })
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    if (wrap) t.wrapS = THREE.RepeatWrapping
    t.anisotropy = 8
    maps.set(url, t)
  }
  return maps.get(url)
}

// A colour node built from mapped(), or from fallback() once any of the textures has failed to load. The
// branch is picked at shader build time, so wrappers placed around mat.colorNode (atmospheres) survive.
function withFallback(mat, urls, mapped, fallback) {
  let down = false
  // a new material property changes the program cache key, forcing a rebuild
  const fail = () => { if (!down) { down = true; mat.mapsDown = 1; mat.needsUpdate = true } }
  for (const url of urls) failed.has(url) ? fail() : loads.addEventListener(url, fail)
  return Fn(() => (down ? fallback() : mapped()))()
}

// Planet maps wrap in longitude; lon0 is the u of longitude 0 in the image (three puts u = 0.5 at +X).
const surface = (look, url, srgb, x = 0, y = 0) => texture(map(url, srgb, true), uv().add(vec2((look.lon0 ?? 0.5) - 0.5 + x, y)))

// Relief from a height map: tilt the object-space normal along the map's east (u) and north (v) axes.
function bumped(look) {
  if (!look.maps.bump) return normalWorld
  const n = normalize(normalLocal)
  const h = (x, y) => surface(look, look.maps.bump, false, x, y).r
  const du = h(1 / 1000, 0).sub(h(-1 / 1000, 0)), dv = h(0, 1 / 500).sub(h(0, -1 / 500))
  const east = normalize(vec3(n.z, 0, n.x.negate()).add(vec3(0, 0, 1e-6))), north = cross(n, east)   // u grows toward -Z at +X
  const nl = normalize(n.sub(east.mul(du).add(north.mul(dv)).mul(look.bump)))
  return modelWorldMatrix.mul(vec4(nl, 0)).xyz
}

// Bodies with real imagery: day albedo, optional city lights, height map and packed bump/roughness/clouds.
function mappedMaterial(look, u, fallback) {
  const mat = new THREE.MeshBasicNodeMaterial()
  mat.colorNode = withFallback(mat, Object.values(look.maps), Fn(() => {
    const raw = surface(look, look.maps.day, true).rgb
    // tame over-coloured or over-bright maps (sat, gain)
    const day = (look.sat == null ? raw : mix(vec3(dot(raw, vec3(0.2126, 0.7152, 0.0722))), raw, look.sat)).mul(look.gain ?? 1)
    const brc = look.maps.brc ? surface(look, look.maps.brc, false) : null
    const clouds = brc ? smoothstep(0.2, 1, brc.b) : float(0)
    const albedo = mix(day, vec3(1), clamp(clouds.mul(2), 0, 1))
    const N = normalize(bumped(look)), L = normalize(u.sun), V = normalize(positionWorld).negate()
    const ndl = dot(N, L)
    const daylight = smoothstep(-0.08, 0.3, ndl)
    const diffuse = daylight.mul(max(ndl, 0).mul(0.8).add(0.2))
    // water is the smooth part of the roughness channel: give it a sun glint
    const water = brc ? smoothstep(0.5, 0.2, brc.g).mul(float(1).sub(clouds)) : float(0)
    const glint = pow(max(dot(reflect(L.negate(), N), V), 0), 60).mul(water).mul(0.8).mul(max(ndl, 0))
    let col = albedo.mul(diffuse).mul(2.2).add(glint).mul(u.sunCol).mul(u.light)
    if (look.maps.night) {
      const lights = surface(look, look.maps.night, true).rgb
      col = col.add(lights.mul(smoothstep(0.1, -0.15, ndl)).mul(float(1).sub(clouds.mul(0.8))).mul(1.4))
    }
    return vec4(col.add(albedo.mul(0.003)), 1)
  }), fallback)
  return mat
}

// A look's numbers as uniforms (colours linear).
function lookUniforms(look, seed) {
  const col = c => uniform(new THREE.Vector3(...toLinear(c)))
  const [c0, c1, c2, c3] = look.cols.map(col)
  const k = { c0, c1, c2, c3, seaCol: col(look.seaCol), off: uniform(new THREE.Vector3((seed % 97) * 1.31, (seed % 89) * 0.77, (seed % 83) * 1.13)) }
  for (const key of ['freq', 'bands', 'turb', 'haze', 'spot', 'craters', 'sea', 'cap', 'cracks', 'clouds', 'lava', 'glow']) k[key] = uniform(look[key] ?? 0)
  return k
}

// u is passed in only when building the procedural fallback of a mapped look (same uniforms).
export function planetMaterial(look, seed, u = { sun: uniform(new THREE.Vector3(1, 0, 0)), sunCol: uniform(new THREE.Color(1, 1, 1)), light: uniform(1) }) {
  if (look.maps) return { mat: mappedMaterial(look, u, () => planetMaterial({ ...look, maps: null }, seed, u).mat.colorNode), u }
  // per-planet numbers are uniforms, so the shader code depends only on which features a look has: planets of a kind
  // share one compiled pipeline instead of compiling their own (seconds per new system)
  const k = lookUniforms(look, seed)
  const { off } = k
  const mat = new THREE.MeshBasicNodeMaterial()
  mat.colorNode = Fn(() => {
    const n = normalize(normalLocal).toVar()
    const albedo = vec3(0).toVar()
    const sea = float(0).toVar()
    if (look.mode === 1) {
      // banded giants: latitude bands warped by turbulence, optional great spot
      const warp = mx_fractal_noise_float(n.mul(vec3(1.4, 5, 1.4)).add(off), 4, 2, 0.5).mul(k.turb)
      const b = sin(n.y.mul(k.bands).add(warp)).mul(0.5).add(0.5)
      const b2 = sin(n.y.mul(k.bands.mul(2.7)).add(warp.mul(1.7))).mul(0.5).add(0.5)
      albedo.assign(mix(mix(k.c0, k.c1, b), mix(k.c2, k.c3, b2), smoothstep(0.35, 0.9, b2).mul(0.55)))
      if (look.haze) albedo.assign(mix(albedo, k.c1, k.haze))            // high haze washes the bands out
      if (look.spot) {
        const sp = length(n.sub(normalize(vec3(0.8, -0.35, 0.5))).mul(vec3(1, 2.4, 1)))
        albedo.assign(mix(albedo, vec3(0.55, 0.2, 0.08), smoothstep(0.16, 0.08, sp).mul(k.spot.mul(0.8))))
      }
    } else {
      const h = mx_fractal_noise_float(n.mul(k.freq).add(off), 6, 2, 0.5).mul(0.5).add(0.5).toVar()
      albedo.assign(mix(mix(k.c0, k.c1, smoothstep(0.3, 0.5, h)), mix(k.c2, k.c3, smoothstep(0.62, 0.8, h)), smoothstep(0.45, 0.65, h)))
      if (look.craters) {
        const w = mx_worley_noise_float(n.mul(7).add(off)), w2 = mx_worley_noise_float(n.mul(19).add(off))
        const crater = smoothstep(0.05, 0.25, w).mul(0.35).add(0.65).mul(smoothstep(0.02, 0.12, w2).mul(0.25).add(0.75))
        albedo.mulAssign(mix(float(1), crater, k.craters))
      }
      if (look.sea > 0) {
        sea.assign(smoothstep(k.sea.add(0.01), k.sea.sub(0.01), h))
        albedo.assign(mix(albedo, k.seaCol.mul(smoothstep(k.sea.sub(0.2), k.sea, h).mul(0.8).add(0.5)), sea))
      }
      if (look.cap) {
        const cap = smoothstep(k.cap, k.cap.add(0.04), abs(n.y).add(h.sub(0.5).mul(0.25)))
        albedo.assign(mix(albedo, vec3(0.74, 0.77, 0.82), cap)); sea.mulAssign(float(1).sub(cap))
      }
      if (look.cracks) {                                    // ice shell split by reddish lineae
        const c1 = abs(mx_noise_float(n.mul(k.freq.mul(1.3)).add(off))), c2 = abs(mx_noise_float(n.mul(k.freq.mul(3.7)).add(off.mul(2))))
        const lines = max(smoothstep(0.07, 0.0, c1), smoothstep(0.045, 0.0, c2).mul(0.7))
        albedo.assign(mix(albedo, vec3(0.2, 0.08, 0.03), lines.mul(k.cracks.mul(0.85))))
      }
      if (look.clouds) {
        const cl = mx_fractal_noise_float(n.mul(3.2).add(off.mul(2)).add(vec3(time.mul(0.002), 0, 0)), 5, 2, 0.55).mul(0.5).add(0.5)
        albedo.assign(mix(albedo, vec3(0.82), smoothstep(k.clouds.mul(0.55).oneMinus(), float(1.05).sub(k.clouds.mul(0.4)), cl)))
      }
    }
    const N = normalize(normalWorld), L = normalize(u.sun), V = normalize(positionWorld).negate()
    const ndl = dot(N, L)
    const diffuse = smoothstep(-0.08, 0.35, ndl).mul(max(ndl, 0).mul(0.75).add(0.25))
    const glint = pow(max(dot(reflect(L.negate(), N), V), 0), 40).mul(sea).mul(0.6).mul(max(ndl, 0))
    const lit = albedo.mul(diffuse).mul(1.7).add(glint).mul(u.sunCol).mul(u.light)
    const lava = look.lava ? vec3(1.8, 0.5, 0.1).mul(smoothstep(0.52, 0.6, mx_noise_float(normalLocal.mul(12).add(off)).mul(0.5).add(0.5))).mul(k.lava.mul(3)) : vec3(0)
    // hot Jupiters glow a dull red on their night side
    const heat = look.glow ? vec3(0.9, 0.22, 0.05).mul(smoothstep(0.15, -0.25, ndl)).mul(albedo.x.mul(3).add(0.3)).mul(k.glow.mul(0.5)) : vec3(0)
    return vec4(lit.add(albedo.mul(0.004)).add(lava).add(heat), 1)
  })()
  return { mat, u }
}

// (atmospheres live in atmosphere.js)

// Rings in the planet's equator with the planet's shadow. Procedural bands and gaps, or real maps:
// tex = { color, alpha, opacity?, gain? }, radial strips sampled at r = (radius - inner) / (outer - inner).
export function ringMaterial(inner, outer, seed, center, planetR, tex = null) {
  const u = { sun: uniform(new THREE.Vector3(1, 0, 0)), center, R: uniform(planetR), light: uniform(1) }
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false })
  const k = { inner: uniform(inner), span: uniform(outer - inner), seed: uniform(seed) }   // uniforms: one shader for all rings
  const r = length(positionLocal.xy).sub(k.inner).div(k.span)
  const procedural = () => {
    const band = mx_noise_float(vec3(r.mul(140), k.seed, 0)).mul(0.5).add(0.5).mul(mx_noise_float(vec3(r.mul(22), k.seed, 3)).mul(0.4).add(0.6))
    const gap = smoothstep(0.02, 0.0, abs(r.sub(0.62))).oneMinus()             // a Cassini-like division
    return [mix(vec3(0.75, 0.66, 0.5), vec3(0.95, 0.9, 0.8), band), band.mul(gap).mul(smoothstep(0, 0.05, r)).mul(smoothstep(1, 0.9, r)).mul(0.85)]
  }
  const mapped = () => {
    const at = vec2(r.oneMinus(), 0.5)                                           // the strips run from the outer edge inwards
    return [texture(map(tex.color, true), at).rgb.mul(tex.gain ?? 1), texture(map(tex.alpha, false), at).r.mul(tex.opacity ?? 1)]
  }
  const shade = look => () => {
    const [col, alpha] = look()
    const p = positionWorld.sub(u.center), L = normalize(u.sun)
    const t = dot(p, L)
    const shadow = select(t.lessThan(0).and(length(p.sub(L.mul(t))).lessThan(u.R)), float(0.08), float(1))
    return vec4(col.mul(shadow).mul(u.light), alpha)
  }
  mat.colorNode = tex ? withFallback(mat, [tex.color, tex.alpha], shade(mapped), shade(procedural)) : Fn(shade(procedural))()
  return { mat, u }
}

// Photosphere: temperature colour, granulation and limb darkening. Output is HDR so it blooms.
export function starMaterial(rgb) {
  const u = { color: uniform(new THREE.Color(...rgb)), glow: uniform(6) }
  const mat = new THREE.MeshBasicNodeMaterial()
  mat.colorNode = Fn(() => {
    const n = normalize(normalLocal)
    const gran = mx_fractal_noise_float(n.mul(40).add(vec3(time.mul(0.02))), 3, 2, 0.5).mul(0.5).add(0.5)
    const mu = abs(dot(normalize(normalWorld), normalize(positionWorld).negate()))
    const limb = pow(mu, 0.5).mul(0.7).add(0.3)
    return vec4(u.color.mul(u.glow).mul(limb).mul(gran.mul(0.35).add(0.75)), 1)
  })()
  return { mat, u }
}

// Accretion disk for a black hole: hot inner edge, turbulent flow.
export function diskMaterial(inner, outer) {
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  mat.colorNode = Fn(() => {
    const r = length(positionLocal.xy).div(inner)
    const a = atan(positionLocal.y, positionLocal.x)
    const swirl = mx_fractal_noise_float(vec3(r.mul(3), a.mul(3).sub(time.mul(0.4).div(r)), 0), 4, 2, 0.5).mul(0.5).add(0.5)
    const heat = pow(float(1).div(r), 1.5)
    const fade = smoothstep(outer / inner, 1.2, r).mul(smoothstep(0.95, 1.1, r))
    return vec4(mix(vec3(1.0, 0.35, 0.08), vec3(1.0, 0.9, 0.75), heat).mul(heat).mul(swirl).mul(fade).mul(3.5), 1)
  })()
  return mat
}

export function orbitMaterial(color, opacity) {
  const mat = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  mat.color = new THREE.Color(color)
  mat.opacity = opacity
  return mat
}
