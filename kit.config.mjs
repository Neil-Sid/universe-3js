// agent-kit config (the kit lives next to this repo in ../agent-kit, see its AGENTS.md). Functions here run inside the page and see its globals
// (uni). Run from this folder:  node ../agent-kit/bin/kit.mjs perf earth
const arrive = name => `uni.travel('${name}'); if (uni.flight.auto) uni.flight.auto.t = uni.flight.auto.T`

export default {
  size: '1920x1080',
  site: 'dist',                                    // what Vercel serves (vercel.json); kit net measures this
  build: 'npm run build',                          // kit ab --site dist builds both sides first
  hosting: { requests: 10e6, bytes: 1e12 },        // Vercel Pro included per month (vercel.com/pricing, 2026-10)
  ready: () => window.uni?.ready === true && !window.uni.variants,     // after the background shader warm-up
  renderer: () => window.uni?.renderer,
  scenes: () => Object.values(window.uni?.layers || {}).map(l => l.scene),
  state: () => ({ pos: uni.flight.pos, selected: uni.selected?.name ?? null }),

  // each one flies there in the first frame (setup ends the trip), then streams for the warm-up
  scenarios: {
    earth: { warmup: 180, frames: 600 },                                     // the start view, beside Earth
    saturn: { setup: new Function(arrive('Saturn')), warmup: 300, frames: 600 },
    orion: { setup: new Function(arrive('Orion Nebula')), warmup: 600, frames: 600 },
    web: { setup: new Function(arrive('Cosmic web')), warmup: 600, frames: 600 },
    // click a system, fly there; then a second one (the user's "lag when I click a new system")
    visit: {
      drive: f => {
        if (f === 150) { uni.ui.selectByName('Sirius'); return 'select Sirius' }
        if (f === 210) { uni.travel('Sirius'); return 'go to Sirius' }
        if (f === 1100) { uni.ui.selectByName('Vega'); return 'select Vega' }
        if (f === 1160) { uni.travel('Vega'); return 'go to Vega' }
      },
      warmup: 120, frames: 1900,
    },
    // scroll out from Earth past the Solar System (one wheel notch every other frame)
    zoomout: {
      drive: f => {
        if (f >= 150 && f < 750 && f % 2 === 0) uni.flight.wheel += 1
        if (f === 150) return 'start zooming out'
      },
      warmup: 120, frames: 900,
    },
  },

  budgets: { p99: 33, max: 80, geometries: 0, textures: 0 },

  lint: { include: ['js'], roots: ['setAnimationLoop', 'requestAnimationFrame'] },
}
