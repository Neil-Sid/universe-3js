// finer split: per layer and post (render-only loop)
window.prof2 = async () => {
  const dev = uni.renderer.backend.device, r = uni.renderer, L = uni.layers
  const time = async fn => {
    fn(); await dev.queue.onSubmittedWorkDone()
    const t0 = performance.now()
    for (let i = 0; i < 12; i++) fn()
    await dev.queue.onSubmittedWorkDone()
    return +((performance.now() - t0) / 12).toFixed(1)
  }
  const layer = l => () => { r.setRenderTarget(uni.rt); r.render(l.scene, l.cam) }
  const out = {
    empty: await time(() => { r.setRenderTarget(uni.rt); r.clear() }),
    cosmos: await time(layer(L.cosmos)), galaxy: await time(layer(L.galaxy)), system: await time(layer(L.system)),
    post: await time(() => { r.setRenderTarget(null); uni.pipeline.render() }),
    full: await time(() => uni.render()),
  }
  r.setRenderTarget(null)
  return out
}
