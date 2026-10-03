window.mxProbe = async () => {
  const THREE = await import('three/webgpu'), TSL = await import('three/tsl'), T = await import('/js/terrain.js')
  const pts = [[0.3, 0.5, 0.81], [-0.7, 0.1, 0.7], [0.11, -0.95, 0.29], [2.5, 1.3, -4.1], [-3.3, 7.7, 0.2]]
  const buf = TSL.instancedArray(pts.length * 2, 'float')
  const inp = TSL.uniformArray(pts.map(p => new THREE.Vector3(...p)), 'vec3')
  const k = TSL.Fn(() => {
    const i = TSL.instanceIndex, p = inp.element(i)
    buf.element(i.mul(2)).assign(TSL.mx_fractal_noise_float(p, 6, 2, 0.5))
    buf.element(i.mul(2).add(1)).assign(TSL.mx_noise_float(p))
  })().compute(pts.length)
  await uni.renderer.computeAsync(k)
  const out = new Float32Array(await uni.renderer.getArrayBufferAsync(buf.value))
  return pts.map((p, i) => [+out[i * 2].toFixed(5), +T._probe.mxFbm(...p, 6).toFixed(5), +out[i * 2 + 1].toFixed(5), +T._probe.mxPerlin(...p).toFixed(5)])
}
