// GPU vs CPU height at the camera's direction (terrain must be active)
window.hProbe = async (lim = 0.5) => {
  const THREE = await import('three/webgpu'), TSL = await import('three/tsl'), T = await import('/js/terrain.js')
  const t = uni.terrain, b = t.body, P = T._probe.profile(b), U = P.gpu.U
  const p = t.camDir, c = t.cam, sea = p.map((v, i) => (v * P.R - c[i]) * 1000)
  const buf = TSL.instancedArray(8, 'float')
  const pu = TSL.uniform(new THREE.Vector3(...p)), su = TSL.uniform(new THREE.Vector3(...sea))
  const relief = T._probe.reliefNode(U)
  const k = TSL.Fn(() => {
    const M = T._probe.tMacro(P, U, pu)
    const r = relief(pu, su, TSL.float(1e30), TSL.float(lim), M.gc, M.rug, M.ridge, M.cd)
    buf.element(0).assign(M.cont); buf.element(1).assign(r.x); buf.element(2).assign(M.rug); buf.element(3).assign(M.ridge); buf.element(4).assign(M.cd)
  })().compute(1)
  await uni.renderer.computeAsync(k)
  const out = [...new Float32Array(await uni.renderer.getArrayBufferAsync(buf.value))].slice(0, 5)
  const m = T._probe.macroCPU(P, P.src, p), r = T._probe.reliefCPU(P, p, lim, m[4], m[1], m[2], m[3])
  return { gpu: out.map(v => +v.toFixed(4)), cpu: [m[0], r[0], m[1], m[2], m[3]].map(v => +v.toFixed(4)) }
}
