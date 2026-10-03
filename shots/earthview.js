// place the camera on the Earth-Sun line (day side), n Earth radii out, optionally rotated about z
window.earthView = (n = 3.5, rot = 0) => {
  const e = uni.system.bodies.find(b => b.name === 'Earth'), s = uni.system.star.p.sub(e.p), l = Math.hypot(...s)
  const c = Math.cos(rot), si = Math.sin(rot), d = [(s[0] * c - s[1] * si) / l, (s[0] * si + s[1] * c) / l, s[2] / l]
  uni.flight.frame = null
  uni.flight.pos = e.p.clone().add(d[0] * e.radius * n, d[1] * e.radius * n, d[2] * e.radius * n)
  uni.lookAt(e.p)
  return new Date().toISOString()
}
