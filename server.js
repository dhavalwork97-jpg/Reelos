// REEL OS — Server
// Proxies both Claude API and Pexels API — no CORS issues
// Render env vars needed: PEXELS_KEY, ANTHROPIC_KEY

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT          = process.env.PORT          || 3000;
const PEXELS_KEY    = process.env.PEXELS_KEY    || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';

// ── Generic HTTPS POST helper ──────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch(e) { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── HTTPS GET helper ───────────────────────────────────────
function httpsGet(hostname, reqPath, headers) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: reqPath, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    }).on('error', reject);
  });
}

// ── Read POST body ─────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) reject(new Error('Too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── Static file server ─────────────────────────────────────
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };
function serveStatic(res, filePath) {
  const type = MIME[path.extname(filePath)] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

// ── HTTP Server ────────────────────────────────────────────
http.createServer(async (req, res) => {
  const { pathname, query } = url.parse(req.url, true);

  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ── POST /api/claude — proxy to Anthropic ───────────────
  if (pathname === '/api/claude' && req.method === 'POST') {
    if (!ANTHROPIC_KEY) { json(500, { error: 'ANTHROPIC_KEY not set in Render environment variables. Go to Render → your service → Environment and add it.' }); return; }
    try {
      const body   = JSON.parse(await readBody(req));
      console.log('[Claude] Sending request, model:', body.model);
      const result = await httpsPost(
        'api.anthropic.com',
        '/v1/messages',
        { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body
      );
      console.log('[Claude] Response status:', result.status);
      if (result.status !== 200) {
        console.error('[Claude] Error body:', JSON.stringify(result.body).slice(0, 500));
      }
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch(e) {
      console.error('[Claude] Exception:', e.message);
      json(500, { error: e.message });
    }
    return;
  }

  // ── GET /api/videos?q=...&n=6 — proxy to Pexels ────────
  if (pathname === '/api/videos') {
    if (!PEXELS_KEY) { json(500, { error: 'PEXELS_KEY not set in Render environment variables.' }); return; }
    const q = query.q || 'urban city';
    const n = Math.min(parseInt(query.n) || 6, 10);
    try {
      const qs   = new URLSearchParams({ query: q, per_page: n, size: 'medium' });
      const data = await httpsGet('api.pexels.com', `/videos/search?${qs}`, { Authorization: PEXELS_KEY });
      const videos = (data.videos || []).map(v => ({
        id:           v.id,
        url:          v.url,
        duration:     v.duration,
        thumb:        v.image,
        file:         v.video_files?.find(f => f.quality === 'sd' && f.width <= 1280)?.link
                   || v.video_files?.[0]?.link,
        photographer: v.user?.name || 'Pexels',
        w: v.width, h: v.height,
      }));
      json(200, { videos });
    } catch(e) { json(500, { error: e.message }); }
    return;
  }

  // ── GET /health ─────────────────────────────────────────
  if (pathname === '/health') {
    json(200, { status: 'ok', pexels: !!PEXELS_KEY, claude: !!ANTHROPIC_KEY });
    return;
  }

  // ── GET /debug — see what keys are loaded ───────────────
  if (pathname === '/debug') {
    json(200, {
      pexels_key_set:    !!PEXELS_KEY,
      pexels_key_prefix: PEXELS_KEY  ? PEXELS_KEY.slice(0,8)+'...'  : 'NOT SET',
      claude_key_set:    !!ANTHROPIC_KEY,
      claude_key_prefix: ANTHROPIC_KEY ? ANTHROPIC_KEY.slice(0,8)+'...' : 'NOT SET',
      node_version:      process.version,
      port:              PORT,
    });
    return;
  }

  // ── Static files ────────────────────────────────────────
  const file = (pathname === '/' || pathname === '/index.html')
    ? path.join(__dirname, 'index.html')
    : path.join(__dirname, pathname.replace(/\.\./g, ''));

  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveStatic(res, file);

}).listen(PORT, () => {
  console.log(`\n  ✅  REEL OS on port ${PORT}`);
  console.log(`  🔑  Pexels: ${PEXELS_KEY  ? 'loaded ✓' : 'NOT SET ⚠️'}`);
  console.log(`  🤖  Claude: ${ANTHROPIC_KEY ? 'loaded ✓' : 'NOT SET ⚠️'}\n`);
});
