// Atmosphere test views. usage in check.cjs: "pre:shots/atmo.js" then "js:return skyView('Earth', 3, 20, 0, 5)"
// skyView(body, altitude km, sun elevation deg, view azimuth from the sun deg, view pitch deg)
window.skyView = (name, alt, elev, az = 0, pitch = 0) => {
  const b = uni.system.bodies.find(x => x.name === name)
  const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l) }
  const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]]
  const s = norm(b.u.sun.value.toArray())
  const side = norm(cross(s, Math.abs(s[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]))
  const e = (90 - elev) * Math.PI / 180
  const up = s.map((v, i) => v * Math.cos(e) + cross(side, s)[i] * Math.sin(e))      // local vertical at a spot with that sun elevation
  const north = norm(cross(up, side)), east = side
  // horizontal direction toward the sun, then turned by az and pitched
  const sh = norm(s.map((v, i) => v - up[i] * (s[0] * up[0] + s[1] * up[1] + s[2] * up[2])))
  const sh2 = norm(cross(up, sh)), a = az * Math.PI / 180, p = pitch * Math.PI / 180
  const hdir = sh.map((v, i) => v * Math.cos(a) + sh2[i] * Math.sin(a))
  const fwd = hdir.map((v, i) => v * Math.cos(p) + up[i] * Math.sin(p))
  const right = norm(cross(fwd, up)), camUp = cross(right, fwd)
  uni.flight.frame = null
  const r = (b.radius + alt * 1e3)
  uni.flight.pos = b.p.clone().add(up[0] * r, up[1] * r, up[2] * r)
  // rotation matrix columns: right, up, -forward -> quaternion
  const m = [right, camUp, fwd.map(v => -v)]
  const [m00, m10, m20] = m[0], [m01, m11, m21] = m[1], [m02, m12, m22] = m[2]
  const tr = m00 + m11 + m22
  let q
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, S / 4] }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [S / 4, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S] }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / S, S / 4, (m12 + m21) / S, (m02 - m20) / S] }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / S, (m12 + m21) / S, S / 4, (m10 - m01) / S] }
  uni.flight.quat.set(...q)
  uni.time.paused = true
  return { alt, elev, az, pitch }
}
