// Renders a 30 s showcase video: headless Chrome on the real GPU, fixed 1/30 s steps, piped to ffmpeg.
//   node tools/film.cjs [out.mp4]        env: FFMPEG (path to ffmpeg), FILM_SIZE=1920x1080
//   FILM_STILLS=3,9,15 saves PNG stills at those seconds into shots/ instead of encoding
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { serve, ROOT } = require('./serve.cjs')
const puppeteer = require('puppeteer-core')

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'video', 'continuum-30s.mp4'))
const [W, H] = (process.env.FILM_SIZE || '1920x1080').split('x').map(Number)
const FRAMES = 30 * 30
const STILLS = process.env.FILM_STILLS ? process.env.FILM_STILLS.split(',').map(s => Math.round(Number(s) * 30)) : null

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const server = await serve()
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, protocolTimeout: 600000,
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H })
  page.on('pageerror', e => console.log('[pageerror]', e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.uni && uni.ready, { timeout: 120000 })
  await page.evaluate(fs.readFileSync(path.join(ROOT, 'shots', 'earthview.js'), 'utf8'))
  await new Promise(r => setTimeout(r, 8000))                       // let textures and streaming settle
  await page.evaluate(() => { uni.renderer.setAnimationLoop(null); uni.clock.getDelta = () => 1 / 30 })
  await page.evaluate(fs.readFileSync(path.join(__dirname, 'film-director.js'), 'utf8'))

  const ff = STILLS ? null : spawn(FFMPEG, ['-y', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'ignore', 'inherit'] })
  const t0 = Date.now()
  for (let i = 0; i < FRAMES; i++) {
    await page.evaluate(n => filmStep(n), i)
    if (STILLS) { if (STILLS.includes(i)) await page.screenshot({ path: path.join(ROOT, 'shots', `film-${(i / 30).toFixed(1)}s.png`) }); continue }
    const jpg = await page.screenshot({ type: 'jpeg', quality: 95 })
    if (!ff.stdin.write(jpg)) await new Promise(r => ff.stdin.once('drain', r))
    if (i % 60 === 0) console.log(`frame ${i}/${FRAMES}  ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
  if (ff) { ff.stdin.end(); await new Promise(r => ff.on('close', r)) }
  await browser.close()
  server.close()
  console.log(STILLS ? 'stills in shots/' : `wrote ${OUT}`)
}

main().catch(e => { console.error(e); process.exit(1) })
