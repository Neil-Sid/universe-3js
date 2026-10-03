// Page-side director for tools/film.cjs: a timed shot list driving the app's autopilot.
// The clock is fixed at 1/30 s per frame, so timing is exact however slowly frames render.
(() => {
  const FPS = 30
  const w = uni
  const find = name => w.find(name).target
  const body = name => w.bodyTarget(w.system.bodies.find(b => b.name === name))
  let cap = null
  w.showOrbits = false                                            // cleaner frames for the film

  // hide the HUD, add a caption block in the app's own type
  for (const s of ['#where', '#ladder', '#readout', '#dest', '#card', '#help', '#sys', '#labels', '#boot']) document.querySelector(s).style.display = 'none'
  document.body.insertAdjacentHTML('beforeend', `
    <div id="film" style="position:fixed;left:7vw;bottom:11vh;pointer-events:none;text-shadow:0 0 18px #000">
      <div id="filmTitle" style="font:italic 500 64px/1 'Cormorant Garamond',serif;color:#e9e2d0"></div>
      <div id="filmSub" style="margin-top:10px;font:300 17px 'IBM Plex Mono',monospace;letter-spacing:.08em;color:#d2ab62"></div>
    </div>
    <div id="filmEnd" style="position:fixed;inset:0;display:grid;place-items:center;opacity:0;pointer-events:none;background:rgba(0,0,0,.35)">
      <div style="text-align:center">
        <div style="font:italic 500 110px/1 'Cormorant Garamond',serif;color:#e9e2d0;letter-spacing:.02em">Continuum</div>
        <div style="margin-top:16px;font:300 18px 'IBM Plex Mono',monospace;letter-spacing:.3em;color:#d2ab62">THE UNIVERSE AT 1 : 1</div>
      </div>
    </div>`)

  // [start s, action, caption title, caption sub, caption from s, caption to s]
  const go = (t, T) => { w.ui.select(t); w.goTo(t); if (w.flight.auto) w.flight.auto.T = T }
  const shots = [
    [0, () => { earthView(3.0, 0.5); w.ui.select(body('Earth')) }, 'Earth', 'LIT FOR THE REAL CURRENT TIME', 0.4, 3.6],
    [4, () => go(body('Saturn'), 4), 'Saturn', '1.4 BILLION KM FROM THE SUN', 7.6, 11.2],
    [11.5, () => go(find('Orion Nebula'), 4), 'The Orion Nebula', '1,344 LIGHT YEARS', 15.2, 18],
    [18.2, () => go(find('Milky Way'), 3.6), 'The Milky Way', '100,000 LIGHT YEARS ACROSS', 21.4, 23.4],
    [23.6, () => go(w.placeTarget('the cosmic web', w.flight.pos.constructor.meters(0, 0, 0), 9.3e24), 3.2), 'The cosmic web', 'A BILLION LIGHT YEARS OF GALAXIES', 26.4, 28.6],
  ]
  const orbit = [[0, 4, 1.6], [8, 11.5, 2.2], [15.5, 18.2, 0.6], [21.8, 23.6, 1.2], [26.8, 30, 1.4]]   // [from, to, px per frame]

  window.filmStep = async i => {
    const t = i / FPS
    for (const [t0, act, title, sub] of shots) if (i === Math.round(t0 * FPS)) { act(); cap = [title, sub] }
    const sh = [...shots].reverse().find(s => t >= s[4])
    const vis = sh && t <= sh[5] ? Math.min(1, (t - sh[4]) / 0.5, (sh[5] - t) / 0.5) : 0
    if (sh) { filmTitle.textContent = sh[2]; filmSub.textContent = sh[3] }
    film.style.opacity = Math.max(0, vis)
    filmEnd.style.opacity = Math.min(1, Math.max(0, (t - 28.4) / 1))
    const o = orbit.find(([a, b]) => t >= a && t < b)
    if (o && !w.flight.auto) w.flight.orbit.dx += o[2]
    w.frame()
    await w.renderer.backend.device.queue.onSubmittedWorkDone()
  }
})()
