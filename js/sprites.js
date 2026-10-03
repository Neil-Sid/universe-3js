// Instanced billboard materials (TSL). Every luminous thing that is small on screen is a sprite:
// stars, galaxy star-clouds, dust, whole galaxies. Sizes are worked out in pixels in the vertex
// shader so a star stays a crisp point at any distance while resolved objects keep their
// surface brightness (a galaxy twice as far is a quarter the area and a quarter the flux).
import * as THREE from 'three/webgpu'
import {
  Fn, attribute, uniform, vec2, vec3, vec4, float, positionGeometry, modelViewMatrix, cameraProjectionMatrix,
  cameraViewMatrix, varyingProperty, length, max, min, exp, smoothstep, log, mix, dot, normalize, cross, abs,
  cos, sin, atan, pow, sqrt, clamp, select, mx_noise_float,
} from 'three/tsl'

export const view = {
  res: uniform(new THREE.Vector2(1280, 720)),   // render target size in pixels
  pxPerRad: uniform(600),                        // pixels per radian at screen centre
}

// Unit quad in [-1,1]^2; the instances carry everything else.
export function quadGeometry(capacity, attrs) {
  const g = new THREE.InstancedBufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3))
  g.setIndex([0, 1, 2, 0, 2, 3])
  for (const [name, size] of Object.entries(attrs)) {
    // static usage: WebGPURenderer re-sends a DynamicDrawUsage buffer on every draw (~49 MB/frame here);
    // upload() bumps the version when the data really changes
    g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size))
  }
  g.instanceCount = 0
  return g
}

// Clip-space position of a pixel-sized quad around a view-space centre.
export const billboard = (viewCenter, halfPx) => {
  const clip = cameraProjectionMatrix.mul(vec4(viewCenter, 1)).toVar()
  const off = positionGeometry.xy.mul(halfPx).mul(2).div(view.res).mul(clip.w)
  return vec4(clip.xy.add(off), clip.z, clip.w)
}

export function spriteMesh(geometry, material) {
  const m = new THREE.Mesh(geometry, material)
  m.frustumCulled = false
  return m
}

// ---- Stars: point sources. Brightness = gain * L / d^2, drawn as a tight core plus a halo that
// grows with brightness. Attributes: iPos (layer units), iColor, iLum (solar luminosities).
export function starSprites(capacity, { gain = 100, hideNear = 0, fadeFar = 1e30, lumScale = 1 } = {}) {
  const g = quadGeometry(capacity, { iPos: 3, iColor: 3, iLum: 1 })
  const u = { gain: uniform(gain), hideNear: uniform(hideNear), fadeFar: uniform(fadeFar), lumScale: uniform(lumScale), opacity: uniform(1) }
  const vI = varyingProperty('float', 'vI'), vHalf = varyingProperty('float', 'vHalf'), vGlow = varyingProperty('float', 'vGlow')
  const vUv = varyingProperty('vec2', 'vUv'), vCol = varyingProperty('vec3', 'vCol')
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })
  mat.vertexNode = Fn(() => {
    const vc = modelViewMatrix.mul(vec4(attribute('iPos', 'vec3'), 1)).xyz.toVar()
    const d = length(vc).toVar()
    const fade = smoothstep(u.hideNear, u.hideNear.mul(1.6), d).mul(smoothstep(u.fadeFar, u.fadeFar.mul(0.75), d))
    const I = u.gain.mul(attribute('iLum', 'float')).mul(u.lumScale).div(d.mul(d)).mul(fade).mul(u.opacity).toVar()
    const glow = float(1.0).add(log(float(1).add(I)).mul(5.0)).toVar()
    const half = select(I.lessThan(0.004), float(0), max(glow.mul(2.6), 3.0))
    vI.assign(I); vHalf.assign(half); vGlow.assign(glow); vUv.assign(positionGeometry.xy); vCol.assign(attribute('iColor', 'vec3'))
    return billboard(vc, half)
  })()
  mat.colorNode = Fn(() => {
    const px = length(vUv).mul(vHalf)
    const core = min(vI, 3.0).mul(exp(px.mul(px).mul(-0.9)))
    const halo = pow(min(vI, 60.0), 0.5).mul(0.06).mul(exp(px.div(vGlow.mul(0.3)).negate()))
    return vec4(vCol.mul(core.add(halo)), 1)
  })()
  return { mesh: spriteMesh(g, mat), u, geometry: g }
}

// ---- Blobs: extended luminous or dark clouds (galaxy star clouds, haze, dust). Surface
// brightness is preserved while resolved; below 1.2 px they fade as unresolved points.
// Attributes: iPos, iColor, iLum (surface brightness), iSize (radius, layer units).
export function blobSprites(capacity, { gain = 1, fadeNear = [0, 0], maxPx = 90, dark = false } = {}) {
  const g = quadGeometry(capacity, { iPos: 3, iColor: 3, iLum: 1, iSize: 1 })
  const u = { gain: uniform(gain), near0: uniform(fadeNear[0]), near1: uniform(fadeNear[1]), maxPx: uniform(maxPx), opacity: uniform(1) }
  const vS = varyingProperty('float', 'vS'), vUv = varyingProperty('vec2', 'vUv'), vCol = varyingProperty('vec3', 'vCol')
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    blending: dark ? THREE.NormalBlending : THREE.AdditiveBlending,
  })
  mat.vertexNode = Fn(() => {
    const vc = modelViewMatrix.mul(vec4(attribute('iPos', 'vec3'), 1)).xyz.toVar()
    const d = length(vc).toVar()
    const pxR = attribute('iSize', 'float').mul(view.pxPerRad).div(max(vc.z.negate(), 1e-6)).toVar()
    const r = clamp(pxR, 1.2, u.maxPx).toVar()
    const unresolved = min(pxR.div(r), 1).pow(2)
    const fade = smoothstep(u.near0, u.near1, d).mul(smoothstep(u.maxPx.mul(2), u.maxPx, pxR))
    const S = attribute('iLum', 'float').mul(u.gain).mul(unresolved).mul(fade).mul(u.opacity).toVar()
    vS.assign(S); vUv.assign(positionGeometry.xy); vCol.assign(attribute('iColor', 'vec3'))
    return billboard(vc, select(S.lessThan(dark ? 0.002 : 0.0005), float(0), r.mul(1.6)))
  })()
  const shape = Fn(() => { const q = length(vUv).mul(1.6); return exp(q.mul(q).mul(-1.4)).mul(smoothstep(1, 0.8, length(vUv))) })
  if (dark) mat.colorNode = Fn(() => vec4(vCol, min(vS.mul(shape()), 0.85)))()
  else mat.colorNode = Fn(() => vec4(vCol.mul(vS).mul(shape()), 1))()
  return { mesh: spriteMesh(g, mat), u, geometry: g }
}

// ---- Galaxies as impostors. Each instance is a disk (or ellipsoid) with its own orientation;
// the fragment shader deprojects the sprite into the disk plane and paints arms, bulge and a dust
// lane. Attributes: iPos, iNormal, iSize (radius), iLum (brightness), iColor (tint),
// iShape (type 0 spiral / 1 elliptical, arm count, pitch, seed).
// fadeNear is in galaxy radii: impostors hand over to particle clouds inside that range.
export function galaxySprites(capacity, { gain = 1, fadeNear = [4, 8] } = {}) {
  const g = quadGeometry(capacity, { iPos: 3, iNormal: 3, iSize: 1, iLum: 1, iColor: 3, iShape: 4 })
  const u = { gain: uniform(gain), near0: uniform(fadeNear[0]), near1: uniform(fadeNear[1]), opacity: uniform(1) }
  const vS = varyingProperty('float', 'vS'), vXY = varyingProperty('vec2', 'vXY'), vCos = varyingProperty('float', 'vCos')
  const vShape = varyingProperty('vec4', 'vShape'), vCol = varyingProperty('vec3', 'vCol'), vRes = varyingProperty('float', 'vRes')
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending })
  mat.vertexNode = Fn(() => {
    const vc = modelViewMatrix.mul(vec4(attribute('iPos', 'vec3'), 1)).xyz.toVar()
    const d = length(vc).toVar()
    const v = vc.div(d)
    const n = normalize(cameraViewMatrix.mul(vec4(attribute('iNormal', 'vec3'), 0)).xyz).toVar()
    const R = attribute('iSize', 'float')
    const pxR = R.mul(view.pxPerRad).div(max(vc.z.negate(), 1e-9)).toVar()
    const r = max(pxR, 1.5).toVar()
    const unresolved = min(pxR.div(r), 1).pow(2)
    const fade = smoothstep(R.mul(u.near0), R.mul(u.near1), d)
    const S = attribute('iLum', 'float').mul(u.gain).mul(unresolved).mul(fade).mul(u.opacity).toVar()
    // disk axes in the view plane: A along the major axis, B along the foreshortened one
    const A = normalize(cross(n.add(vec3(1e-4, 2e-4, 0)), v)).toVar()
    const B = cross(v, A)
    const corner = vec3(positionGeometry.xy, 0)
    vXY.assign(vec2(dot(corner, A), dot(corner, B)))
    vCos.assign(max(abs(dot(n, v)), 0.1))
    vS.assign(S); vShape.assign(attribute('iShape', 'vec4')); vCol.assign(attribute('iColor', 'vec3')); vRes.assign(pxR)
    return billboard(vc, select(S.lessThan(0.0003), float(0), r))
  })()
  mat.colorNode = Fn(() => {
    const x = vXY.x, y = vXY.y
    const elliptical = vShape.x.greaterThan(0.5)
    // spiral: deproject into the disk plane
    const yd = y.div(vCos)
    const rr = length(vec2(x, yd)).toVar()
    const th = atan(yd, x)
    const arms = vShape.y, pitch = vShape.z, seed = vShape.w
    const spiral = cos(arms.mul(th.sub(log(rr.add(0.02)).div(pitch))).add(seed.mul(6.28))).mul(0.5).add(0.5)
    const clump = mx_noise_float(vec3(x.mul(9), yd.mul(9), seed.mul(17))).mul(0.5).add(0.5)
    const disk = exp(rr.mul(-4.2)).mul(float(0.25).add(pow(spiral, 3).mul(1.3).mul(clump.add(0.4))))
    const dust = float(1).sub(exp(y.div(0.035).pow(2).negate()).mul(float(1).sub(vCos)).mul(0.75))
    const bulgeR = length(vec2(x, y))
    const bulge = exp(bulgeR.mul(bulgeR).mul(-90)).mul(1.8)
    const diskLight = disk.div(vCos).mul(dust).mul(smoothstep(1, 0.75, rr))
    const armBlue = mix(vec3(1.0, 0.85, 0.62), vec3(0.62, 0.75, 1.0), smoothstep(0.05, 0.4, rr))
    const spiralCol = armBlue.mul(diskLight).add(vec3(1.0, 0.82, 0.55).mul(bulge))
    // elliptical: smooth de Vaucouleurs-like falloff with the tint baked in
    const e = length(vec2(x, y.div(mix(1, 0.55, seed))))
    const ell = exp(pow(e.add(0.001), 0.25).mul(-7.6)).mul(900).mul(smoothstep(1, 0.7, e))
    const ellCol = vec3(1.0, 0.8, 0.58).mul(ell)
    // unresolved galaxies collapse to a soft point
    const point = exp(length(vec2(x, y)).pow(2).mul(-6)).mul(2.2)
    const shaped = select(elliptical, ellCol, spiralCol)
    const col = mix(vec3(1, 0.88, 0.7).mul(point), shaped, smoothstep(1.5, 5, vRes))
    return vec4(col.mul(vCol).mul(vS), 1)
  })()
  return { mesh: spriteMesh(g, mat), u, geometry: g }
}

// Fill instance attributes from plain arrays; call geometry.instanceCount = n afterwards.
export function upload(geometry, data, n) {
  for (const [name, arr] of Object.entries(data)) {
    const a = geometry.getAttribute(name)
    a.array.set(n * a.itemSize < arr.length ? arr.subarray(0, n * a.itemSize) : arr)
    a.clearUpdateRanges()
    a.addUpdateRange(0, n * a.itemSize)
    a.needsUpdate = true
  }
  geometry.instanceCount = n
}

// Blackbody-ish colour for a star temperature (K), normalised to max channel 1.
export function tempColor(T, out = [0, 0, 0]) {
  const t = T / 100
  let r, g, b
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04 }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255 }
  out[0] = Math.min(1, Math.max(0, r / 255)); out[1] = Math.min(1, Math.max(0, g / 255)); out[2] = Math.min(1, Math.max(0, b / 255))
  return out
}
