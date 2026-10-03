// Dress Earth as a generated world of some kind, with that kind's air. usage: "js:return await atmoKind('marslike')"
window.atmoKind = async (kind, seed = 7) => {
  const { proceduralLook } = await import('/js/looks.js')
  const { planetMaterial } = await import('/js/materials.js')
  const { atmosphere } = await import('/js/atmosphere.js')
  const { Rng } = await import('/js/rng.js')
  const e = uni.system.bodies.find(b => b.name === 'Earth')
  const look = proceduralLook(kind, new Rng(seed)), m = planetMaterial(look, seed)
  Object.assign(e, { look, kind, u: m.u })
  if (e.air) e.group.remove(e.air.mesh)
  e.air = look.atmo ? atmosphere(e, uni.system.star) : null
  if (e.air) { m.mat.colorNode = e.air.surface(m.mat.colorNode); e.group.add(e.air.mesh) }
  e.mesh.material = m.mat
  earthView(4.2, 0.9)
  return kind + (e.air ? '' : ' (no air)')
}
