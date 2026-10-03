// GPU-side profile: frame time with each component hidden in turn (render-only loop, no streaming)
window.prof = async () => {
  const dev = uni.renderer.backend.device
  const time = async () => {
    uni.render(); await dev.queue.onSubmittedWorkDone()
    const t0 = performance.now()
    for (let i = 0; i < 12; i++) uni.render()
    await dev.queue.onSubmittedWorkDone()
    return +((performance.now() - t0) / 12).toFixed(1)
  }
  const parts = {
    deepsky: [uni.deepsky.root],
    clouds: [...uni.clouds.values()].map(c => c.group),
    levels: uni.levels.map(l => l.sprites.mesh),
    catalog: [uni.catalog.sprites.mesh],
    system: uni.system ? [uni.system.root] : [],
    cosmos: [uni.layers.cosmos.scene],
  }
  const out = { all: await time() }
  for (const [k, objs] of Object.entries(parts)) {
    const vis = objs.map(o => o.visible)
    objs.forEach(o => { o.visible = false })
    out['-' + k] = await time()
    objs.forEach((o, i) => { o.visible = vis[i] })
  }
  uni.renderer.setRenderTarget(null)
  return out
}
