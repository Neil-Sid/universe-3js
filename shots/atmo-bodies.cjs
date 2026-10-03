// visit atmospheric bodies: node tools/check.cjs "pre:shots/atmo.js" "steps:shots/atmo-bodies.cjs" [only=Venus,Titan]
const view = (name, n, rot = 0.5) => `js:const b = uni.system.bodies.find(x => x.name === '${name}'), s = uni.system.star.p.sub(b.p), l = Math.hypot(...s); const c = Math.cos(${rot}), si = Math.sin(${rot}); const d = [(s[0]*c - s[1]*si)/l, (s[0]*si + s[1]*c)/l, s[2]/l]; uni.flight.frame = null; uni.flight.auto = null; uni.flight.pos = b.p.clone().add(d[0]*b.radius*${n}, d[1]*b.radius*${n}, d[2]*b.radius*${n}); uni.lookAt(b.p); return '${name}'`
const space = (name, n) => [view(name, n), 'wait:3', `shot:atmo-${name.toLowerCase()}.png`]
const sky = (name, file, alt, elev, az, pitch) => [`js:return skyView('${name}', ${alt}, ${elev}, ${az}, ${pitch})`, 'wait:2', `shot:atmo-${file}.png`]
const only = (process.env.ONLY || '').split(',').filter(Boolean)
const all = {
  Mars: [...space('Mars', 3), ...sky('Mars', 'mars-day', 1, 25, 120, 10), ...sky('Mars', 'mars-sunset', 1, 1.5, 0, 6)],
  Venus: space('Venus', 3), Jupiter: space('Jupiter', 2.6), Saturn: space('Saturn', 4), Neptune: space('Neptune', 3),
  Titan: [...space('Titan', 3), ...sky('Titan', 'titan-sky', 2, 30, 90, 10)],
}
module.exports = ['wait:5', ...Object.entries(all).filter(([k]) => !only.length || only.includes(k)).flatMap(([, v]) => v)]
