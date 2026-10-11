const http = require('http');
const fs = require('fs');
const path = require('path');
const { getScoreboard } = require('./src/espn');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/scoreboard') {
    try {
      return sendJson(res, 200, await getScoreboard(url.searchParams.get('dates')));
    } catch (err) {
      console.error(`[scoreboard] ${err.message}`);
      return sendJson(res, err.status || 502, { error: err.message });
    }
  }

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    sendJson(res, 500, { error: 'Internal error' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`KOAS Meda predictor on http://localhost:${PORT}${process.env.MOCK === '1' ? ' (mock data)' : ''}`);
  });
}

module.exports = server;
