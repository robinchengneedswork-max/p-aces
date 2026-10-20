// serve.js — tiny static server. Camera access needs a secure context; localhost counts.
// MediaPipe fetches its .wasm and model, which file:// can't do.
// POST /recordings saves a gesture recording (G in the game) to recordings/ for
// tools/analyze-recording.js. /duel is the WebSocket for 1v1 LAN duels (duel-server.js): the
// server listens on the network so the other laptop's game can connect to it (Windows Firewall
// asks once). Each laptop still opens its OWN copy on localhost: the camera needs a secure origin.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { attachDuel } = require('./duel-server');

const PORT = 8068;
const ROOT = __dirname;
const RECORDINGS = path.join(ROOT, 'recordings');
const MAX_RECORDING = 40 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.tflite': 'application/octet-stream', '.json': 'application/json',
};

function saveRecording(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_RECORDING) { res.writeHead(413); res.end(); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    try { JSON.parse(body); } catch (e) { res.writeHead(400); res.end('not json'); return; }
    fs.mkdirSync(RECORDINGS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = 'rec-' + stamp + '.json';
    fs.writeFileSync(path.join(RECORDINGS, name), body);
    console.log('Saved recording → recordings/' + name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file: 'recordings/' + name }));
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && urlPath === '/recordings') { saveRecording(req, res); return; }
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  // Listening on the network now: other machines get the game only, not the recordings.
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (!local && (file.startsWith(RECORDINGS) || req.method === 'POST')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    // no-store: during development the browser must never mix cached old modules with new ones
    // (a local run once found no hands while the same build on Vercel was fine).
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});
const duel = attachDuel(server);
server.listen(PORT, '0.0.0.0', () => {
  console.log('Sky Ace → http://localhost:' + PORT + '/');
  setTimeout(() => { if (duel.lan.length) console.log('Duel: the other laptop joins ' + duel.lan[0]); }, 1000);
});
