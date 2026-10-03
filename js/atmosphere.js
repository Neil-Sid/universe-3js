// Physically based atmospheres: single scattering by gas (Rayleigh) and aerosols (Mie), plus a cheap
// isotropic multiple-scattering term, marched along the view ray. Sunlight reaching each sample
// comes from an analytic Chapman column, so there is no inner loop and no lookup table.
// Units are the system layer's km, camera at the origin, body centre in the body's `center` uniform.
//
// Two pieces per body:
//   - a back-faced shell for the sky: the limb from space, the whole sky from inside. Back faces
//     sit behind the planet, so the shell never covers the ground.
//   - surface(colorNode): aerial perspective for the ground (the planet sphere, or any terrain).
import * as THREE from 'three/webgpu'
import {
  Fn, uniform, vec3, vec4, float, positionWorld, normalize, dot, max, min, abs, exp, sqrt, pow, mix, step,
  smoothstep, clamp, select, length, cross, Loop, If,
} from 'three/tsl'
import { LOOKS, toLinear } from './looks.js'
import { KM } from './units.js'
import { view } from './sprites.js'

const SUN = 4.5         // sunlight in scene units: a lit white surface is ~2.2 (x pi for radiance)
const ADAPT = 2.2      // eyes adapt under a sky: air glows this much brighter seen from the ground
const DISK = 10        // the sun's disk, redrawn through the air so it reddens at sunset
const MS = 0.05        // isotropic multiple scattering, as a fraction of the single-scattered light
const HIDE = 0.92      // how much a bright sky hides what is behind it (stars)
const STEPS = 16       // view-ray samples, packed toward the densest air
const PI = Math.PI
const smooth = x => (x = Math.min(1, Math.max(0, x))) * x * (3 - 2 * x)

// ---- air per world -----------------------------------------------------------------------------
// top: shell height; hR, hM: gas / aerosol scale heights (km). ray: Rayleigh scattering at the
// surface; mie, abs: aerosol scattering and absorption (/km, rgb); g: aerosol forward lobe (rgb).
const RAY = [5.802e-3, 13.558e-3, 33.1e-3]                 // Earth air at sea level
const ray = k => RAY.map(v => v * k)
const rgb = (r, g = r, b = r) => [r, g, b]
const air = o => ({ top: 100, hR: 8, ray: RAY, hM: 1.2, mie: rgb(0.008), abs: rgb(0.0009), g: rgb(0.76), ...o })
const giant = (H, k, tint, m, abs = rgb(0)) => air({ top: H * 12, hR: H, ray: ray(k), hM: H, mie: tint.map(v => v * m), abs, g: rgb(0.7) })

const EARTH = air({})
// thin CO2 under suspended dust: red light scatters wide (butterscotch sky), blue stays near the sun (blue sunsets)
const MARS = air({ top: 90, hR: 11, ray: ray(0.02), hM: 11, mie: rgb(0.042, 0.03, 0.018), abs: rgb(0.004, 0.012, 0.024), g: rgb(0.6, 0.68, 0.82) })
// the visible sphere is the cloud deck; above it, CO2 and sulphuric haze
const VENUS = air({ top: 90, hR: 6, ray: ray(0.2), hM: 5, mie: rgb(0.1, 0.09, 0.065), abs: rgb(0, 0.003, 0.012), g: rgb(0.5) })
// nitrogen piled under thick orange tholin haze that absorbs blue
const TITAN = air({ top: 500, hR: 40, ray: ray(0.4), hM: 70, mie: rgb(0.022, 0.014, 0.006), abs: rgb(0.001, 0.004, 0.01), g: rgb(0.6) })

export const AIR = {
  earth: EARTH, mars: MARS, venus: VENUS, titan: TITAN,
  jupiter: giant(27, 0.1, [1, 0.9, 0.75], 0.003),
  saturn: giant(60, 0.06, [1, 0.92, 0.7], 0.002),
  uranus: giant(28, 0.3, [0.6, 0.9, 1], 0.002),
  neptune: giant(20, 0.4, [0.45, 0.65, 1], 0.002),
  // generated worlds, by kind
  ocean: EARTH, tundra: air({ hR: 7.5 }),
  waterworld: air({ mie: rgb(0.02), hM: 1.5 }),
  arid: air({ hM: 2, mie: rgb(0.025, 0.022, 0.018), abs: rgb(0.002, 0.003, 0.005) }),
  desert: air({ top: 80, hR: 10, ray: ray(0.25), hM: 8, mie: rgb(0.03, 0.024, 0.016), abs: rgb(0.002, 0.006, 0.012), g: rgb(0.65, 0.7, 0.78) }),
  marslike: MARS, venus: VENUS, hazy: TITAN,
  gas: giant(30, 0.08, [1, 0.95, 0.85], 0.003),
  icegiant: giant(25, 0.35, [0.5, 0.8, 1], 0.002),
  subneptune: giant(40, 0.3, [0.75, 0.88, 1], 0.006),
  hotjupiter: giant(120, 0.1, [1, 0.6, 0.35], 0.002, rgb(0, 0.0008, 0.002)),
}

// Solar System bodies are keyed by their look name, generated ones by kind; anything else gets a
// generic haze tinted by look.atmo.
export function airFor(b, look) {
  const named = AIR[Object.keys(LOOKS).find(k => LOOKS[k] === look)] ?? AIR[b.kind]
  if (named) return named
  const c = toLinear(look.atmo), m = Math.max(...c), top = Math.max((look.atmoH * b.radius) / KM, 40)
  return air({ top, hR: top / 10, ray: ray(0.4), hM: top / 10, mie: c.map(v => (v / m) * 0.006), abs: rgb(0.0006), g: rgb(0.7) })
}

// ---- maths -------------------------------------------------------------------------------------
// Air column (km of surface-density air) from radius r toward cosine mu, for scale height H.
// exp(y^2) erfc(y) ~ 2 / (sqrt(pi) (y + sqrt(y^2 + 4/pi))) keeps it within 6% of exact at all angles.
function column(r, mu, H, R) {
  const x = r.div(H)
  const y = abs(mu).mul(sqrt(x.mul(0.5)))
  const up = exp(r.sub(R).div(H).negate()).mul(sqrt(x.mul(2)).div(y.add(sqrt(y.mul(y).add(4 / PI)))))
  // looking down: the whole chord through the lowest point minus the part behind us
  const r0 = r.mul(sqrt(max(mu.mul(mu).oneMinus(), 0)))
  const chord = sqrt(r0.div(H).mul(2 * PI)).mul(exp(min(R.sub(r0).div(H), 40)))
  return select(mu.greaterThanEqual(0), up, chord.sub(up)).mul(H)
}

// Transmittance from radius r toward the sun (cosine muS), zero in the planet's shadow.
function sunlight(A, r, muS, shadow = true) {
  const od = A.ray.mul(column(r, muS, A.hR, A.R)).add(A.extSun.mul(column(r, muS, A.hM, A.R)))
  const T = exp(od.negate())
  if (!shadow) return T
  const horizon = sqrt(max(A.R.div(r).pow(2).oneMinus(), 0)).negate()
  return T.mul(smoothstep(horizon.sub(0.004), horizon.add(0.004), muS))
}

const phaseR = c => c.mul(c).add(1).mul(3 / (16 * PI))
// Cornette-Shanks: Henyey-Greenstein with a Rayleigh-like back lobe, per channel
function phaseM(c, g) {
  const g2 = g.mul(g)
  const hg = g2.oneMinus().div(pow(max(g2.add(1).sub(g.mul(c).mul(2)), 1e-4), vec3(1.5))).mul(1 / (4 * PI))
  return hg.mul(c.mul(c).add(1).mul(1.5)).div(g2.add(2))
}

// Entry/exit distances of the ray o + rd t with a sphere of radius rad (no hit: near > far).
function sphere(b, camR, rad) {
  const d = b.mul(b).sub(camR.sub(rad).mul(camR.add(rad)))      // factored: exact near the surface
  const s = sqrt(max(d, 0))
  const hit = d.greaterThan(0)
  return { near: select(hit, b.negate().sub(s), float(1e30)), far: select(hit, b.negate().add(s), float(-1e30)) }
}

// In-scattered light S (per unit sun) and transmittance T along rd, from the camera to tMax.
// ground: stop at the planet (for the sky shell; surfaces pass their own distance).
function scatter(A, o, camR, rd, L, tMax, ground) {
  const b = dot(o, rd)
  const top = sphere(b, camR, A.top)
  const t0 = max(top.near, 0).toVar()
  const t1 = min(top.far, tMax).toVar()
  if (ground) {
    const g = sphere(b, camR, A.ground)
    If(g.near.greaterThan(0), () => { t1.assign(min(t1, g.near)) })
  }
  const S = vec3(0).toVar(), od = vec3(0).toVar()
  If(t1.greaterThan(t0), () => {
    const mu = dot(rd, L)
    const pR = phaseR(mu), pM = phaseM(mu, A.g)
    // samples bunch up quadratically around the closest approach to the planet, where air is densest
    const len = t1.sub(t0), k = clamp(b.negate().sub(t0).div(len), 0, 1)
    const warp = f => select(f.lessThan(k), k.sub(k.mul(k.sub(f).div(max(k, 1e-6)).pow(2))), k.add(k.oneMinus().mul(f.sub(k).div(max(k.oneMinus(), 1e-6)).pow(2))))
    Loop(STEPS, ({ i }) => {
      const ta = t0.add(len.mul(warp(float(i).div(STEPS)))), tb = t0.add(len.mul(warp(float(i).add(1).div(STEPS))))
      const dt = tb.sub(ta), P = o.add(rd.mul(ta.add(tb).mul(0.5)))
      const r = length(P), h = max(r.sub(A.R), 0)
      const dR = exp(h.div(A.hR).negate()), dM = exp(h.div(A.hM).negate())
      const ext = A.ray.mul(dR).add(A.ext.mul(dM))
      const muS = dot(P, L).div(r)
      // multiple scattering: past the terminator only air above the planet's shadow stays lit
      const hSh = max(muS.negate(), 0).pow(2).mul(A.R.mul(0.5))
      const Tms = sunlight(A, max(r, hSh.add(A.R)), min(max(muS, 0).add(0.1), 1), false).mul(exp(max(hSh.sub(h), 0).div(A.hR).negate()))
      const rayS = A.ray.mul(dR), mieS = A.mie.mul(dM)
      const src = sunlight(A, r, muS).mul(rayS.mul(pR).add(mieS.mul(pM))).add(rayS.add(mieS).mul(Tms).mul(MS))
      // exact integral over the segment: (1 - e^-x) / x, with its series where x is tiny
      const x = ext.mul(dt)
      const f = mix(x.mul(-0.5).add(1), exp(x.negate()).oneMinus().div(max(x, 1e-9)), step(vec3(1e-3), x))
      S.addAssign(exp(od.negate()).mul(src).mul(f).mul(dt))
      od.addAssign(x)
    })
  })
  return { S, T: exp(od.negate()) }
}

// ---- per body ----------------------------------------------------------------------------------
// body: from System.addBody (needs radius, look, u.sun/sunCol/light, center, dist); star: the
// system's primary (radius, dist) for the sun's disk.
export function atmosphere(body, star) {
  const p = airFor(body, body.look), R = body.radius / KM, top = R + p.top
  // all uniforms: the shader code is then the same for every body, so one compiled pipeline serves them all
  const v = a => uniform(new THREE.Vector3(...a))
  const A = {
    R: uniform(R), top: uniform(top), ground: uniform(R * 0.9995), hR: uniform(p.hR), hM: uniform(p.hM),   // ground sits under the mesh facets
    ray: v(p.ray), mie: v(p.mie), ext: v(p.mie.map((m, i) => m + p.abs[i])), g: v(p.g),
    // sunlight scattered forward by aerosols mostly carries on: drop that share from its extinction
    extSun: v(p.mie.map((m, i) => m * (1 - p.g[i]) + p.abs[i])),
  }
  const { sun, sunCol, light } = body.u
  // camera distance from the centre, from float64 on the CPU: the horizon needs metre precision
  const camR = uniform(R * 10).onRenderUpdate(() => (body.dist ? body.dist / KM : undefined))
  const sunAng = uniform(0.005).onRenderUpdate(() => (star.dist ? star.radius / star.dist : undefined))
  const L = normalize(sun)
  const o = normalize(body.center).negate().mul(camR)            // camera, planet-centred
  const adapt = uniform(1).onRenderUpdate(() => body.dist && 1 + (ADAPT - 1) * smooth((top - body.dist / KM) / p.top))
  const sunI = sunCol.mul(light).mul(adapt).mul(SUN)

  // Aerial perspective for a surface colour at a world position: sunlight reddens near the
  // terminator, then the air in front adds its glow and dims what is behind.
  const apply = (col, pos) => {
    // stop at the true sphere where the mesh facets dip below it (terrain above it ends first)
    const rd = normalize(pos), g = sphere(dot(o, rd), camR, A.R)
    const { S, T } = scatter(A, o, camR, rd, L, min(length(pos), select(g.near.greaterThan(0), g.near, float(1e30))), false)
    const n = pos.sub(body.center), muS = dot(normalize(n), L)
    // direct sun plus some skylight, relative to the overhead sun the albedo maps are lit by
    const Ts = sunlight(A, A.R, muS, false).add(0.15).div(sunlight(A, A.R, float(1), false).add(0.15))
    const hue = Ts.div(max(max(Ts.x, Ts.y), max(Ts.z, 1e-4)))
    const tint = mix(vec3(1), hue, smoothstep(-0.02, 0.03, muS))
    return col.mul(tint).mul(T).add(S.mul(sunI))
  }

  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthWrite: false })
  // premultiplied: sky + background * (1 - alpha)
  Object.assign(mat, { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor })
  mat.colorNode = Fn(() => {
    const rd = normalize(positionWorld)
    const { S, T } = scatter(A, o, camR, rd, L, float(1e30), true)
    const sky = S.mul(sunI)
    // a bright sky hides the stars (and the sun mesh, so the disk is redrawn here through the air)
    const a = max(dot(T, vec3(1 / 3)).oneMinus(), smoothstep(0.004, 0.08, dot(sky, vec3(0.2126, 0.7152, 0.0722))).mul(HIDE))
    const px = float(1.5).div(view.pxPerRad)
    const disk = smoothstep(sunAng.add(px), sunAng.sub(px), length(cross(rd, L))).mul(step(0, dot(rd, L)))
    return vec4(sky.add(sunCol.mul(disk.mul(DISK)).mul(T).mul(a)), a)
  })()
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat)
  mesh.scale.setScalar(top / 0.995)                                // facets must stay outside the shell
  return {
    mesh, params: p, R, top,
    apply,                                                         // (vec3 colour, vec3 world position) -> vec3, inside a Fn
    surface: colorNode => Fn(() => vec4(apply(colorNode.rgb, positionWorld), colorNode.a))(),
  }
}
