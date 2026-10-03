// Test helper: landAt(name, altitude m, pitch deg, sun zenith deg, heading deg) puts the camera above
// a body's day side, riding with it, looking toward the horizon. Needs the terrain to be ready.
window.landAt = async (name, alt, pitch = -8, sunZen = 55, head = 0) => {
  const THREE = await import('three/webgpu')
  const w = uni, b = w.system.bodies.find(x => x.name === name)
  const s = new THREE.Vector3(...w.system.star.p.sub(b.p)).normalize()
  const side = new THREE.Vector3(0, 0, 1).cross(s).normalize()
  const up = s.clone().applyAxisAngle(side, (sunZen * Math.PI) / 180)
  const probe = b.p.clone().add(up.x * b.radius, up.y * b.radius, up.z * b.radius)
  const g = w.terrain.ground(w.system, b, probe) ?? b.radius
  const r = g + alt
  w.flight.auto = null
  w.flight.pos = b.p.clone().add(up.x * r, up.y * r, up.z * r)
  w.flight.frame = b
  w.flight.local = w.flight.pos.sub(b.p)
  const east = side.clone().applyAxisAngle(up, (head * Math.PI) / 180)
  const fwd = east.clone().applyAxisAngle(new THREE.Vector3().crossVectors(up, east).normalize(), 0).normalize()
  const look = fwd.clone().multiplyScalar(Math.cos((pitch * Math.PI) / 180)).addScaledVector(up, Math.sin((pitch * Math.PI) / 180))
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), look, up)
  w.flight.quat.setFromRotationMatrix(m)
  return { ground: g - b.radius, alt }
}
window.altInfo = () => ({ surf: uni.surf, ...uni.terrain.stats() })
// orbitAt(name, distance in radii from the centre, sun angle deg): look at the body's day side
window.orbitAt = async (name, k, sunAng = 40) => {
  const THREE = await import('three/webgpu')
  const w = uni, b = w.system.bodies.find(x => x.name === name)
  const s = new THREE.Vector3(...w.system.star.p.sub(b.p)).normalize()
  const side = new THREE.Vector3(0, 0, 1).cross(s).normalize()
  const u = s.clone().applyAxisAngle(side, (sunAng * Math.PI) / 180).multiplyScalar(k * b.radius)
  w.flight.auto = null
  w.flight.pos = b.p.clone().add(u.x, u.y, u.z)
  w.flight.frame = b
  w.flight.local = w.flight.pos.sub(b.p)
  w.lookAt(b.p)
  return k
}
// camera direction in the body frame and altitude over time (co-rotation check)
window.drift = async (name, secs = 4) => {
  const THREE = await import('three/webgpu')
  const w = uni, b = w.system.bodies.find(x => x.name === name), out = []
  for (let k = 0; k <= secs; k++) {
    const q = w.system.orient(b), d = w.flight.pos.sub(b.p)
    const v = new THREE.Vector3(...d).applyQuaternion(q.invert())
    out.push([+(v.x).toFixed(2), +(v.y).toFixed(2), +(v.z).toFixed(2), +w.surf.toFixed(2), w.flight.frame?.name])
    await new Promise(r => setTimeout(r, 1000))
  }
  return out
}
// landLL(name, lat, lon or null, alt m, pitch, heading from north deg, sunLon offset): body-frame lat/lon;
// lon null = dLon degrees west of the subsolar meridian (morning light)
window.landLL = async (name, lat, lon, alt, pitch = -8, head = 90, dLon = 40) => {
  const THREE = await import('three/webgpu')
  const w = uni, b = w.system.bodies.find(x => x.name === name), q = w.system.orient(b)
  const sunB = new THREE.Vector3(...w.system.star.p.sub(b.p)).normalize().applyQuaternion(q.clone().invert())
  if (lon === null) lon = (Math.atan2(-sunB.z, sunB.x) * 180) / Math.PI - dLon
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180
  const dirB = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo))
  const up = dirB.clone().applyQuaternion(q)
  const probe = b.p.clone().add(up.x * b.radius, up.y * b.radius, up.z * b.radius)
  const g = w.terrain.ground(w.system, b, probe) ?? b.radius, r = g + alt
  w.flight.auto = null
  w.flight.pos = b.p.clone().add(up.x * r, up.y * r, up.z * r)
  w.flight.frame = b
  w.flight.local = w.flight.pos.sub(b.p)
  const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const north = pole.clone().addScaledVector(up, -pole.dot(up)).normalize(), east = new THREE.Vector3().crossVectors(north, up)
  const h = (head * Math.PI) / 180, fwd = north.clone().multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h))
  const p = (pitch * Math.PI) / 180, look = fwd.multiplyScalar(Math.cos(p)).addScaledVector(up, Math.sin(p))
  w.flight.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), look, up))
  w.surf = alt                                   // flight speed reads last frame's surf
  return { lat, lon: +lon.toFixed(2), ground: +(g - b.radius).toFixed(1) }
}
// the first landable planet (else moon) of the current system, preferring worlds with seas
window.pickRocky = async () => {
  const T = await import('/js/terrain.js'), bs = uni.system.bodies.filter(T.landable)
  const b = bs.find(x => x.type === 'planet' && x.look.sea > 0) || bs.find(x => x.type === 'planet') || bs[0]
  return b ? { name: b.name, kind: b.kind, R: Math.round(b.radius / 1000), atmo: !!b.look.atmo, sea: b.look.sea } : null
}
// a land point (ground above minH km) in morning light: scans dLon 25..60 west of the subsolar point
window.findLand = async (name, minH = 0.3) => {
  const THREE = await import('three/webgpu'), T = await import('/js/terrain.js')
  const w = uni, b = w.system.bodies.find(x => x.name === name), q = w.system.orient(b)
  const sunB = new THREE.Vector3(...w.system.star.p.sub(b.p)).normalize().applyQuaternion(q.clone().invert())
  const sl = (Math.atan2(-sunB.z, sunB.x) * 180) / Math.PI
  for (let dl = 25; dl <= 60; dl += 5) for (let lat = -40; lat <= 40; lat += 4) {
    const la = (lat * Math.PI) / 180, lo = ((sl - dl) * Math.PI) / 180
    const h = T.heightAt(b, [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)])
    if (h > minH) return { lat, lon: +(sl - dl).toFixed(2), h }
  }
  return null
}
window.goStar = async (x, y, z, name) => {
  uni.jumpLy(x, y, z); await new Promise(r => setTimeout(r, 4000))
  const e = uni.systemsNear(60, 40).find(e => e.star.name === name); uni.goToStar(e.star)
  await new Promise(r => setTimeout(r, 20000)); return uni.system?.star?.name
}
