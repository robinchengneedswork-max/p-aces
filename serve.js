// serve.js — tiny static server. Camera access needs a secure context; localhost counts.
// MediaPipe fetches its .wasm and model, which file:// can't do.
// POST /recordings saves a gesture recording (G in the game) to recordings/ for
// tools/analyze-recording.js.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8068;
const ROOT = __dirname;
const RECORDINGS = path.join(ROOT, 'recordings');
const MAX_RECORDING = 40 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.json': 'application/json',
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

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && urlPath === '/recordings') { saveRecording(req, res); return; }
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log('Sky Ace → http://localhost:' + PORT + '/'));
