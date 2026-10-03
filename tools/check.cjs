// Headless harness on the real GPU with WebGPU. Serves the app, waits for boot, runs steps, prints
// results and console problems. Exit code 1 on page errors.
//
//   node tools/check.cjs "js:uni.travel('Saturn')" "wait:20" "shot:saturn.png" "js:uni.backend"
//
// Steps: wait:<s>  js:<code, may await; value printed>  shot:<file in shots/>[@x,y,w,h]  url:<query>
//        steps:<file.cjs exporting an array of steps> (expanded in place)
//        pre:<file.js> (runs in the page before any of its scripts, e.g. to wrap GPUDevice calls)
// Env:   CHECK_SIZE=WxH (default 1600x900)
const fs = require('fs')
const path = require('path')
const { serve, ROOT } = require('./serve.cjs')

let puppeteer
try { puppeteer = require('puppeteer-core') } catch { console.error('Run `npm install` first (the harness needs puppeteer-core).'); process.exit(2) }
// Chrome or Edge on the machine; override with CHROME_PATH
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

async function main() {
  const steps = process.argv.slice(2).flatMap(s => s.startsWith('steps:') ? require(path.resolve(s.slice(6))) : [s])
  const server = await serve()
  const base = `http://127.0.0.1:${server.address().port}/`
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 300000,
    args: ['--mute-audio', '--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const errors = []
  const page = await browser.newPage()
  const [vw, vh] = (process.env.CHECK_SIZE || '1600x900').split('x').map(Number)
  await page.setViewport({ width: vw, height: vh })
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`)
    else if (m.type() === 'info') console.log(`info> ${m.text()}`)
  })
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))

  for (const s of steps.filter(s => s.startsWith('pre:'))) await page.evaluateOnNewDocument(fs.readFileSync(path.resolve(s.slice(4)), 'utf8'))
  const urlStep = steps.find(s => s.startsWith('url:'))
  const t0 = Date.now()
  await page.goto(base + (urlStep ? urlStep.slice(4) : '?dev'))
  try {
    await page.waitForFunction(() => window.uni && window.uni.ready, { timeout: 120000, polling: 100 })
    console.log(`ready> ${((Date.now() - t0) / 1000).toFixed(1)} s after navigation`)
  } catch { console.log('universe did not become ready within 120 s') }

  fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true })
  for (const step of steps) {
    const i = step.indexOf(':'), kind = step.slice(0, i), arg = step.slice(i + 1)
    if (kind === 'wait') await new Promise(r => setTimeout(r, parseFloat(arg) * 1000))
    else if (kind === 'js') {
      try {
        const body = /\breturn\b|;/.test(arg) ? arg : `return (${arg})`
        const value = await page.evaluate(`(async () => { ${body} })()`)
        console.log(`js> ${arg.slice(0, 90)}\n  = ${JSON.stringify(value)}`)
      } catch (e) { console.log(`js> ${arg.slice(0, 90)}\n  ! ${e.message}`) }
    } else if (kind === 'shot') {
      const [name, clip] = arg.split('@')
      const file = path.isAbsolute(name) ? name : path.join(ROOT, 'shots', name)
      const [x, y, width, height] = clip ? clip.split(',').map(Number) : []
      await page.screenshot({ path: file, ...(clip && { clip: { x, y, width, height } }) })
      console.log(`shot> ${file}`)
    }
  }
  console.log(errors.length ? `\n${errors.length} console problem(s):\n${[...new Set(errors)].join('\n')}` : '\nno console errors')
  await browser.close()
  server.close()
  process.exit(errors.some(e => e.startsWith('[pageerror]')) ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(2) })
