window.showKind = async (kind, seed = 7) => {
  const { proceduralLook } = await import('/js/looks.js')
  const { planetMaterial } = await import('/js/materials.js')
  const { Rng } = await import('/js/rng.js')
  const e = uni.system.bodies.find(b => b.name === 'Earth')
  const m = planetMaterial(proceduralLook(kind, new Rng(seed)), seed)
  e.mesh.material = m.mat; e.u = m.u
  e.group.children.slice(1).forEach(c => c.visible = false)
  earthView(3.2, 0.9)
  return kind
}
