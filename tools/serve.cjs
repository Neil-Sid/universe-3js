// Tiny static file server (no dependencies). `node tools/serve.cjs [port]` serves the app on localhost.
// Also used by tools/check.cjs, which asks for a random free port.
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }

function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0])
    const file = path.join(ROOT, url === '/' ? 'index.html' : url)
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
  })
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)))
}

module.exports = { serve, ROOT }

if (require.main === module) {
  const port = Number(process.argv[2]) || 5270
  serve(port).then(() => console.log(`Continuum: http://localhost:${port}`))
}
