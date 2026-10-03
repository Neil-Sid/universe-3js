// usage in check.cjs: "js:return await fps()"
window.fps = async (secs = 3) => {
  const t = []
  await new Promise(r => { const t0 = performance.now(); const f = now => { t.push(now); if (now - t0 < secs * 1000) requestAnimationFrame(f); else r() }; requestAnimationFrame(f) })
  const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b)
  return { fps: +(1000 / (d.reduce((a, b) => a + b) / d.length)).toFixed(1), p95ms: +d[Math.floor(d.length * 0.95)].toFixed(1) }
}
