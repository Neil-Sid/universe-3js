// HUD: where you are, how fast, what's selected, where you can go. Plain DOM, updated ~10x/s;
// labels every frame.
import { fmtDist, fmtSpeed, num, AU, LY, MPC, KM, DAY, YEAR, R_EARTH, R_SUN, OBSERVABLE_RADIUS, C } from './units.js'
import { REAL_STARS } from './catalog.js'
import { view } from './sprites.js'
import { DEEP_SKY_NAMES } from './deepsky.js'

const $ = s => document.querySelector(s)
const J2000 = Date.UTC(2000, 0, 1, 12)

const DESTINATIONS = [
  ['Solar System', ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Europa', 'Saturn', 'Titan', 'Uranus', 'Neptune', 'Pluto']],
  ['Stars', ['Proxima Centauri', 'Alpha Centauri A', 'Sirius', 'Vega', 'Arcturus', 'Polaris', 'Betelgeuse', 'Rigel', 'Deneb', 'VY Canis Majoris', 'Eta Carinae', 'TRAPPIST-1']],
  ['The Galaxy', ['Sagittarius A*', 'Milky Way']],
  ['Nebulae & clusters', DEEP_SKY_NAMES],
  ['Local Universe', ['Large Magellanic Cloud', 'Andromeda (M31)', 'Triangulum (M33)', "Bode's Galaxy (M81)", 'Centaurus A', 'Whirlpool Galaxy (M51)', 'Sombrero Galaxy (M104)', 'Messier 87']],
  ['Largest Scales', ['Cosmic web', 'Observable universe']],
]
const NOTES = {
  'Cosmic web': 'filaments of galaxy clusters, ~1 Gpc across',
  'Observable universe': '93 billion light years across',
}
// ladder ticks: log10 metres
const TICKS = [[0, '1 m'], [3, '1 km'], [6.8, 'Earth'], [9.84, 'Sun'], [11.17, '1 AU'], [15.98, '1 light year'], [20.7, 'Milky Way'], [22.49, '1 Mpc'], [25.49, '1 Gpc'], [26.94, 'observable universe']]
const LOG_MAX = 27.2
const STAR_NAMES = {
  O: 'O · blue main-sequence star', B: 'B · blue-white main-sequence star', A: 'A · white main-sequence star', F: 'F · yellow-white main-sequence star',
  G: 'G · yellow dwarf', K: 'K · orange dwarf', M: 'M · red dwarf', L: 'L · brown dwarf', T: 'T · brown dwarf (methane)', D: 'white dwarf',
  'G III': 'G III · yellow giant', 'K III': 'K III · orange giant', 'M I': 'M I · red supergiant', 'B I': 'B I · blue supergiant',
}
// catalogue stars carry full types like 'M5.5 V'; generated ones carry the class key
const starKind = spec => STAR_NAMES[spec] ?? (spec === 'SMBH' ? 'supermassive black hole' : /^D[A-Z]/.test(spec) ? `white dwarf · ${spec}` : `${spec} star`)
const shortKind = spec => /^D/.test(spec) ? 'white dwarf' : STAR_NAMES[spec]?.split(' · ').pop().replace(/ \(.*\)/, '') ?? spec
const MULTIPLICITY = ['single', 'single', 'binary', 'triple', 'quadruple']
const fmtPeriod = P => P > YEAR * 1.5 ? `${num(P / YEAR)} years` : `${num(P / DAY)} days`
const KIND_NAMES = {
  lava: 'lava world', rock: 'rocky world', desert: 'desert world', venus: 'greenhouse world', ocean: 'earth-like world', waterworld: 'ocean world',
  arid: 'arid world', marslike: 'cold desert world', tundra: 'tundra world', frozen: 'frozen ocean world', iceworld: 'ice world',
  subneptune: 'sub-Neptune', gas: 'gas giant', hotjupiter: 'hot Jupiter', icegiant: 'ice giant', volcanic: 'volcanic moon', hazy: 'hazy moon', dwarf: 'dwarf planet',
}

export class UI {
  constructor(world) {
    this.w = world
    this.t = 0
    this.labels = []
    this.buildLadder()
    this.buildDestinations()
    this.bindSearch()
    this.bindKeys()
    $('#goBtn').onclick = () => this.sel && world.goTo(this.sel)
    $('#lookBtn').onclick = () => this.sel && world.lookAt(this.sel.getPos())
  }

  buildLadder() {
    const rail = $('#rail')
    for (let e = 0; e <= 27; e++) rail.insertAdjacentHTML('beforeend', `<div class="tick minor" style="top:${this.ladderY(e)}%"></div>`)
    for (const [e, s] of TICKS) rail.insertAdjacentHTML('beforeend', `<div class="tick" style="top:${this.ladderY(e)}%"><span>${s}</span></div>`)
  }
  ladderY(e) { return 100 - (e / LOG_MAX) * 100 }

  buildDestinations() {
    const list = $('#destList'), btn = $('#destBtn')
    const fixed = DESTINATIONS.map(([h, items]) => `<h3>${h}</h3>` + items.map(n => `<button data-go="${n}">${n}${NOTES[n] ? `<small>${NOTES[n]}</small>` : ''}</button>`).join('')).join('')
    const wander = `<h3>Wander</h3>
      <button data-wander="near">A random star system nearby<small>within ~90 ly</small></button>
      <button data-wander="galaxy">A random system anywhere in this galaxy</button>
      <button data-wander="far">A random system in another galaxy</button>`
    // the nearby list is rebuilt every time the panel opens: it depends on where you are
    const open = () => {
      this.nearby = this.w.systemsNear(60, 14)
      const near = this.nearby.length ? `<h3>Nearby star systems</h3>` + this.nearby.map((e, i) =>
        `<button data-near="${i}">${e.star.name}<small>${e.star.spec} · ${fmtDist(e.d * LY)} · ${e.planets} planet${e.planets === 1 ? '' : 's'}</small></button>`).join('') : ''
      list.innerHTML = wander + near + fixed
    }
    btn.onclick = () => { if (list.hidden) open(); list.hidden = !list.hidden; btn.setAttribute('aria-expanded', !list.hidden) }
    list.onclick = e => {
      const b = e.target.closest('button')
      if (!b) return
      if (b.dataset.go) this.go(b.dataset.go)
      if (b.dataset.wander) this.w.wander(b.dataset.wander)
      if (b.dataset.near) this.w.goToStar(this.nearby[+b.dataset.near].star)
      list.hidden = true
    }
  }

  go(name) {
    const near = this.nearby?.find(e => e.star.name === name)
    if (near) return this.w.goToStar(near.star)
    const f = this.w.find(name)
    if (f) { if (!f.then) this.select(f.target); this.w.goTo(f.target, f.then && (() => { f.then(); setTimeout(() => this.sel?.name?.toLowerCase() !== name.toLowerCase() && this.selectByName(name), 0) })) }
    else this.w.travel(name)
  }
  selectByName(name) { const f = this.w.find(name); if (f) this.select(f.target) }

  // Everything in the current system, for one-click travel.
  onSystem(sys) {
    const box = $('#sys')
    box.hidden = !sys
    if (!sys) return
    const planets = sys.bodies.filter(b => b.type === 'planet'), moons = sys.bodies.filter(b => b.type === 'moon')
    const stars = sys.stars ?? [sys.star]
    $('#sysName').textContent = sys.star.name === 'Sun' ? 'Solar System' : `${sys.name ?? sys.star.name} system`
    $('#sysMeta').textContent = `${stars.length > 1 ? MULTIPLICITY[stars.length] ?? 'multiple' : ''} ${stars.map(s => s.spec || '').join(' + ')} · ${planets.length} planets · ${moons.length} moons`.trim()
    const row = (b, cls) => `<li class="${cls}" data-b="${sys.bodies.indexOf(b)}">${b.name}</li>`
    $('#sysList').innerHTML = sys.bodies.filter(b => !b.orbit).map(b => row(b, 'star')).join('') +
      planets.map(p => row(p, 'planet') + moons.filter(m => m.parent === p).map(m => row(m, 'moon')).join('')).join('')
    $('#sysList').onclick = e => {
      const li = e.target.closest('li')
      if (!li || !this.w.system) return
      const t = this.w.bodyTarget(this.w.system.bodies[+li.dataset.b])
      this.select(t); this.w.goTo(t)
    }
  }

  bindSearch() {
    const input = $('#search'), out = $('#results')
    const names = () => {
      const all = DESTINATIONS.flatMap(([, items]) => items).concat(REAL_STARS.flatMap(s => [s.name, ...(s.multiple?.stars.map(m => m[0]) ?? [])]))
      if (this.w.system) all.push(...this.w.system.bodies.map(b => b.name))
      this.nearby = this.w.systemsNear(60, 40)
      all.push(...this.nearby.map(e => e.star.name))
      return [...new Set(all)]
    }
    let hits = [], on = 0
    const render = () => { out.innerHTML = hits.map((h, i) => `<li class="${i === on ? 'on' : ''}" data-i="${i}">${h}</li>`).join('') }
    input.oninput = () => {
      const q = input.value.trim().toLowerCase()
      hits = q ? names().filter(n => n.toLowerCase().includes(q)).slice(0, 8) : []
      on = 0; render()
    }
    input.onkeydown = e => {
      if (e.key === 'ArrowDown') { on = Math.min(on + 1, hits.length - 1); render(); e.preventDefault() }
      if (e.key === 'ArrowUp') { on = Math.max(on - 1, 0); render(); e.preventDefault() }
      if (e.key === 'Enter' && hits[on]) { this.go(hits[on]); input.value = ''; hits = []; render(); input.blur() }
      if (e.key === 'Escape') { input.value = ''; hits = []; render(); input.blur() }
      e.stopPropagation()
    }
    out.onclick = e => { const li = e.target.closest('li'); if (li) { this.go(hits[+li.dataset.i]); input.value = ''; hits = []; render() } }
  }

  bindKeys() {
    const w = this.w, time = w.time
    addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return
      switch (e.code) {
        case 'Space': time.paused = !time.paused; e.preventDefault(); break
        case 'Period': time.warp = Math.min(time.warp * 10, 1e10); break
        case 'Comma': time.warp = Math.max(time.warp / 10, 1); break
        case 'Slash': time.warp = 1; time.paused = false; break
        case 'BracketRight': w.flight.speedMul = Math.min(w.flight.speedMul * 2, 64); break
        case 'BracketLeft': w.flight.speedMul = Math.max(w.flight.speedMul / 2, 1 / 64); break
        case 'KeyG': if (this.sel) w.goTo(this.sel); break
        case 'KeyL': if (this.sel) w.lookAt(this.sel.getPos()); break
        case 'KeyO': w.showOrbits = !w.showOrbits; break
        case 'KeyH': $('#help').classList.toggle('hide'); break
        case 'Escape': w.flight.cancelAuto(); w.pendingNext = null; break
        case 'Backspace': this.select(null); break
      }
    })
  }

  // ---- selection card ----
  select(t) {
    this.sel = t
    this.w.selected = t
    $('#card').hidden = !t
    if (!t) return
    $('#cardName').textContent = t.name
    this.cardStatic = this.facts(t)
    this.refreshCard()
  }

  facts(t) {
    const f = []
    if (t.kind === 'planet' || t.kind === 'moon') {
      const b = t.body
      const what = KIND_NAMES[b.kind]
      $('#cardKind').textContent = (what ? what + ' · ' : '') + (t.kind === 'moon' ? `moon of ${b.parent.name}` : `orbits ${b.parent.name}`)
      f.push(['radius', `${num(b.radius / KM)} km`], ['', `${num(b.radius / R_EARTH)} Earth radii`])
      f.push(['orbit', fmtDist(b.orbit.a)])
      const P = Math.abs(2 * Math.PI / b.orbit.n)
      f.push(['period', P > YEAR * 1.5 ? `${num(P / YEAR)} years` : `${num(P / DAY)} days`])
      if (b.rotation) f.push(['day', `${num(Math.abs(b.rotation) / 3600)} h${b.rotation < 0 ? ' (retrograde)' : ''}`])
      if (b.teq) f.push(['temperature', `${Math.round(b.teq)} K equilibrium`])
    } else if (t.kind === 'star' || (t.body && t.body.type === 'star')) {
      const s = t.star || t.body
      $('#cardKind').textContent = starKind(s.spec)
      f.push(['temperature', `${num(s.T)} K`], ['luminosity', `${num(s.L)} L☉`], ['radius', `${num((s.radius ?? s.R * R_SUN) / R_SUN)} R☉`])
      if (t.star) f.push(['planets', this.w.planetCount(t.star)])
      const comp = t.body ? t.body.companions : this.w.companions(t.star)
      if (comp?.length) f.push(['system', `${MULTIPLICITY[comp.length + 1] ?? 'multiple'} · companion${comp.length > 1 ? 's' : ''}: ${comp.map(c => `${c.name} (${shortKind(c.spec)})`).join(', ')}`])
      if (t.body?.binary) f.push(['orbit', `${fmtDist(t.body.binary.a)} · ${fmtPeriod(t.body.binary.P)} · ${t.body.binary.around}`])
    } else if (t.kind === 'blackhole' || t.body?.type === 'blackhole') {
      $('#cardKind').textContent = 'supermassive black hole'
      f.push(['mass', '4.3 million M☉'], ['event horizon', fmtDist(t.radius)])
    } else if (t.kind === 'galaxy') {
      const g = t.galaxy
      $('#cardKind').textContent = `${g.type} galaxy${g.real ? '' : ' · procedural'}`
      f.push(['diameter', `${num(g.R * 2)} ly`])
      if (g.type === 'spiral') f.push(['arms', g.arms])
    } else if (t.kind === 'deepsky') {
      const o = t.dso
      $('#cardKind').textContent = `${o.type} · Milky Way`
      f.push(['from Earth', `${num(o.ly)} ly`], ['diameter', `~${num(o.radius * 2)} ly`], ...o.facts)
    } else $('#cardKind').textContent = 'place'
    return f
  }

  refreshCard() {
    if (!this.sel) return
    const d = this.w.flight.pos.dist(this.sel.getPos())
    const rows = [['distance', fmtDist(d)], ...(d > LY * 0.5 ? [['light time', lightTime(d)]] : []), ...this.cardStatic]
    $('#cardFacts').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
  }


  // ---- per frame ----
  update(dt) {
    this.t += dt
    this.drawLabels()
    if (this.t < 0.1) return
    this.t = 0
    const w = this.w, f = w.flight
    const place = this.place()
    $('#crumbs').innerHTML = place.crumbs.map(c => `<li>${c}</li>`).join('')
    $('#place').textContent = place.name
    $('#placeNote').textContent = place.note || ''
    $('#speed').textContent = f.auto ? 'autopilot' : fmtSpeed(f.speed)
    $('#mult').textContent = f.speedMul !== 1 ? `throttle ×${f.speedMul}` : ''
    $('#surf').textContent = fmtDist(w.surf)
    const date = new Date(J2000 + w.time.t * 1000)
    $('#date').textContent = isNaN(date) ? `year ${num(2000 + w.time.t / YEAR)}` : date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    $('#warp').textContent = w.time.paused ? 'paused' : w.time.warp > 1 ? `×${num(w.time.warp)}` : ''
    const e = Math.max(0, Math.min(LOG_MAX, Math.log10(Math.max(w.surf, 1))))
    $('#needle').style.top = this.ladderY(e) + '%'
    $('#needleText').textContent = fmtDist(w.surf)
    this.refreshCard()
  }

  // Name of where the camera is, plus breadcrumbs up the hierarchy.
  place() {
    const w = this.w, pos = w.flight.pos
    const fromSun = Math.hypot(...pos.meters())
    const crumbs = ['Observable Universe']
    if (fromSun > OBSERVABLE_RADIUS) return { crumbs: [], name: 'Beyond the observable universe', note: `${fmtDist(fromSun - OBSERVABLE_RADIUS)} past the edge, as seen from Earth` }
    if (fromSun < 1.6 * MPC) crumbs.push('Local Group')
    const g = w.galaxy
    if (!g) {
      const n = [...w.clouds.values()].map(c => c.g).find(Boolean)
      return { crumbs, name: fromSun > 50 * MPC ? 'Deep intergalactic space' : 'Intergalactic space', note: n ? `near ${n.name}` : `${fmtDist(fromSun)} from the Sun` }
    }
    crumbs.push(g.name)
    const s = w.system
    if (!s) {
      const n = w.nearStars[0], dso = w.deepsky.around()
      if (dso) crumbs.push(dso.name)
      return { crumbs, name: dso ? dso.name.replace(/ \(.*\)$/, '') : 'Interstellar space', note: (dso ? `inside the ${dso.type} · ` : '') + (n ? `${num(n.d)} ly to the nearest star` : '') }
    }
    const sysName = s.star.name === 'Sun' ? 'Solar System' : `${s.name ?? s.star.name} system`
    crumbs.push(sysName)
    const fr = w.flight.frame
    if (fr) return { crumbs, name: fr.name, note: `altitude ${fmtDist(fr.p.dist(pos) - (w.terrain.ground(s, fr, pos) ?? fr.radius))}` }   // above the terrain
    return { crumbs, name: sysName, note: `${fmtDist(s.star.p.dist(pos))} from ${s.star.name}` }
  }

  // ---- labels ----
  drawLabels() {
    const w = this.w, cam = w.flight.pos, items = []
    const add = (name, rel, cls, prio, radius = 0) => {
      const p = w.project(rel)
      if (!p || p[0] < -50 || p[0] > innerWidth + 50 || p[1] < 0 || p[1] > innerHeight) return
      const pxR = Math.min((radius / p[2]) * view.pxPerRad.value / w.renderer.getPixelRatio(), innerHeight)
      items.push({ name, x: p[0] + pxR * 0.72, y: p[1] - pxR * 0.72, cls, prio })
    }
    if (w.system) {
      for (const b of w.system.bodies) {
        const rel = b.p.sub(cam)
        if (b.type === 'moon' && b.parent.p.dist(cam) > b.orbit.a * 60) continue
        if (b === w.flight.frame && b.dist < b.radius * 4) continue
        add(b.name, rel, b.type === 'moon' ? 'moon' : b.type === 'planet' ? 'planet' : 'star', b.type === 'moon' ? 1 : 3, b.radius)
      }
    }
    if (!w.system || w.system.star.p.dist(cam) > 200 * AU) {
      for (const s of REAL_STARS) {
        const rel = [s.pos[0], s.pos[1], s.pos[2]].map((v, i) => v - cam.meters()[i])
        const d = Math.hypot(...rel) / LY
        if ((100 * s.L) / (d * d) > 0.8 || d < 12) add(s.name, rel, 'star', 2)
      }
    }
    for (const g of w.cosmos.namedList) {
      const rel = g.pos.map((v, i) => v - cam.meters()[i])
      const d = Math.hypot(...rel)
      const ang = (g.R * LY) / d
      if (ang > 0.004 && d > g.R * LY * 1.2) add(g.name, rel, 'galaxy', 2 + ang)
    }
    if (w.deepsky.root.visible) for (const o of w.deepsky.list) {
      if (this.sel?.dso === o) continue
      const rel = o.upos.sub(cam), ang = (o.radius * LY) / Math.hypot(...rel)
      if (ang > 0.012 && ang < 0.8) add(o.name, rel, 'dso', 1.5 + ang)
    }
    if (this.sel) add(this.sel.name, this.sel.getPos().sub(cam), 'sel', 99, this.sel.radius)
    items.sort((a, b) => b.prio - a.prio)
    const placed = []
    const shown = items.filter(it => {
      const wdt = it.name.length * 7.5
      if (placed.some(p => Math.abs(p.y - it.y) < 16 && it.x < p.x + p.w && p.x < it.x + wdt)) return false
      placed.push({ x: it.x, y: it.y, w: wdt })
      return true
    }).slice(0, 40)
    while (this.labels.length < shown.length) { const d = document.createElement('div'); $('#labels').appendChild(d); this.labels.push(d) }
    this.labels.forEach((el, i) => {
      const it = shown[i]
      if (!it) { el.style.display = 'none'; return }
      el.style.display = ''
      el.className = 'lbl ' + it.cls
      if (el.textContent !== it.name) el.textContent = it.name
      el.style.left = it.x + 'px'; el.style.top = it.y + 'px'
    })
  }
}

function lightTime(d) {
  const s = d / C
  if (s < 3600 * 48) return `${num(s / 3600)} light hours`
  if (s < YEAR) return `${num(s / DAY)} light days`
  return `${num(s / YEAR)} years`
}
