// Deploy build (Vercel runs `npm run build`, serves dist/): the 21 modules under js/ bundled into dist/js/main.js, so a
// visit makes 3 requests to the host instead of 23. three.js stays external, loaded from the CDN by index.html's import
// map, and index.html and the CSS are copied unchanged. Local development keeps using the modules directly.
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..'), dist = path.join(root, 'dist')
fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(path.join(dist, 'css'), { recursive: true })

await build({
  entryPoints: [path.join(root, 'js/main.js')],
  outfile: path.join(dist, 'js/main.js'),
  bundle: true,
  format: 'esm',
  target: 'esnext',                // ship the code as written: no syntax lowering
  external: ['three', 'three/*'],  // resolved by the import map
  logLevel: 'warning',
})
fs.copyFileSync(path.join(root, 'index.html'), path.join(dist, 'index.html'))
fs.copyFileSync(path.join(root, 'css/style.css'), path.join(dist, 'css/style.css'))

for (const f of ['index.html', 'css/style.css', 'js/main.js']) console.log(`dist/${f}  ${(fs.statSync(path.join(dist, f)).size / 1024).toFixed(0)} KB`)
