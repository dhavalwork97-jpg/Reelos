// REEL OS — Server v5
// Render env vars:
//   PEXELS_KEY      — required
//   PIXABAY_KEY     — optional (enabled automatically when key is present)
//   GROQ_KEY        — required (free at console.groq.com)
//   ANTHROPIC_KEY   — optional, set AI_PROVIDER=claude to activate
//   AI_PROVIDER     — 'groq' (default) | 'claude'

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT          = process.env.PORT          || 3000;
const PEXELS_KEY    = process.env.PEXELS_KEY    || '';
const PIXABAY_KEY   = process.env.PIXABAY_KEY   || '';
const GROQ_KEY      = process.env.GROQ_KEY      || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const AI_PROVIDER   = (process.env.AI_PROVIDER  || 'groq').toLowerCase();

// Pixabay enabled automatically whenever key is present
const PIXABAY_ON = !!PIXABAY_KEY;

// ── HTTPS helpers ──────────────────────────────────────────
function httpsPost(hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      { hostname, path: reqPath, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      res => {
        let r = '';
        res.on('data', c => r += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(r) }); }
          catch(e) { resolve({ status: res.statusCode, body: r }); }
        });
      }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

function httpsGet(hostname, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: reqPath, headers }, res => {
      let r = '';
      res.on('data', c => r += c);
      res.on('end', () => {
        try { resolve(JSON.parse(r)); }
        catch(e) { reject(new Error('Parse error: ' + r.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e6) reject(new Error('Too large')); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

// ── Pick highest quality video file ───────────────────────
// Priority: widest file = highest resolution (4K > 1080p > 720p > SD)
function pickBestFile(files) {
  if (!files || !files.length) return null;
  const sorted = [...files].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted.find(f => f.link)?.link || null;
}

function getQualityLabel(files) {
  if (!files || !files.length) return 'SD';
  const best = [...files].sort((a, b) => (b.width||0) - (a.width||0))[0];
  const w = best?.width || 0;
  if (w >= 3840) return '4K';
  if (w >= 1920) return 'HD 1080p';
  if (w >= 1280) return 'HD 720p';
  return 'SD';
}

function getBestFileWidth(files) {
  if (!files || !files.length) return 0;
  return Math.max(...files.map(f => f.width || 0));
}

// ── AI providers ───────────────────────────────────────────
async function callGroq(messages, system, maxTokens) {
  if (!GROQ_KEY) throw new Error('GROQ_KEY not set — get a free key at console.groq.com');
  const result = await httpsPost(
    'api.groq.com', '/openai/v1/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    { model: 'llama-3.3-70b-versatile', max_tokens: maxTokens || 2000, temperature: 0.85,
      messages: [{ role: 'system', content: system }, ...messages] }
  );
  if (result.status !== 200)
    throw new Error('Groq: ' + (result.body?.error?.message || JSON.stringify(result.body).slice(0, 200)));
  return { content: [{ type: 'text', text: result.body?.choices?.[0]?.message?.content || '{}' }] };
}

async function callClaude(messages, system, maxTokens) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY not set or no credits');
  const result = await httpsPost(
    'api.anthropic.com', '/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    { model: 'claude-sonnet-4-5', max_tokens: maxTokens || 2000, system, messages }
  );
  if (result.status !== 200)
    throw new Error('Claude: ' + (result.body?.error?.message || JSON.stringify(result.body).slice(0, 200)));
  return result.body;
}

async function callAI(messages, system, maxTokens) {
  return AI_PROVIDER === 'claude'
    ? callClaude(messages, system, maxTokens)
    : callGroq(messages, system, maxTokens);
}

// ── Pexels search ──────────────────────────────────────────
async function searchPexels(query, n, page) {
  if (!PEXELS_KEY) return [];
  const pg = page || (Math.floor(Math.random() * 5) + 1);
  const qs = new URLSearchParams({ query, per_page: n, page: pg });
  try {
    const data = await httpsGet('api.pexels.com', `/videos/search?${qs}`, { Authorization: PEXELS_KEY });
    return (data.videos || []).map(v => ({
      id:           'px_' + v.id,
      source:       'Pexels',
      url:          v.url,
      duration:     v.duration,
      thumb:        v.image,
      file:         pickBestFile(v.video_files),
      photographer: v.user?.name || 'Pexels',
      w:            v.width,
      h:            v.height,
      quality:      getQualityLabel(v.video_files),
      fileWidth:    getBestFileWidth(v.video_files),
    }));
  } catch(e) { console.warn('[Pexels]', e.message); return []; }
}

// ── Pixabay search — enabled when key present ──────────────
async function searchPixabay(query, n) {
  if (!PIXABAY_ON) return [];
  // Pixabay has rate limits — add small delay to avoid 429
  await new Promise(r => setTimeout(r, 300));
  const qs = new URLSearchParams({
    key:        PIXABAY_KEY,
    q:          query,
    video_type: 'film',
    per_page:   Math.min(n, 20),   // Pixabay max per_page=20
    page:       Math.floor(Math.random() * 3) + 1,
  });
  try {
    const data = await httpsGet('pixabay.com', `/api/videos/?${qs}`);
    if (data.error) { console.warn('[Pixabay] API error:', data.error); return []; }
    return (data.hits || []).map(v => {
      // Pixabay provides large, medium, small, tiny — pick largest
      const best = v.videos?.large?.url ? v.videos.large
                 : v.videos?.medium?.url ? v.videos.medium
                 : v.videos?.small;
      const w = best?.width || 1280;
      return {
        id:           'pb_' + v.id,
        source:       'Pixabay',
        url:          `https://pixabay.com/videos/id-${v.id}/`,
        duration:     v.duration,
        thumb:        v.videos?.medium?.thumbnail || v.videos?.small?.thumbnail || '',
        file:         best?.url || '',
        photographer: v.user || 'Pixabay',
        w:            w,
        h:            best?.height || 720,
        quality:      w >= 3840 ? '4K' : w >= 1920 ? 'HD 1080p' : w >= 1280 ? 'HD 720p' : 'SD',
        fileWidth:    w,
      };
    });
  } catch(e) { console.warn('[Pixabay]', e.message); return []; }
}

// ── Multi-source search with duration filter ───────────────
// minDur / maxDur in seconds — filters clips to requested length
async function searchAll(query, n, minDur, maxDur, extraPage) {
  const page = extraPage || (Math.floor(Math.random() * 5) + 1);

  // Search both sources in parallel
  const [pexels, pixabay] = await Promise.all([
    searchPexels(query, Math.min(n * 2, 15), page),  // fetch more so we have enough after filtering
    PIXABAY_ON ? searchPixabay(query, 10) : Promise.resolve([]),
  ]);

  // Merge — interleave so we get variety from both sources
  const merged = [];
  const maxLen = Math.max(pexels.length, pixabay.length);
  for (let i = 0; i < maxLen; i++) {
    if (pexels[i])  merged.push(pexels[i]);
    if (pixabay[i]) merged.push(pixabay[i]);
  }

  // Deduplicate by file URL
  const seen = new Set();
  const deduped = merged.filter(v => {
    if (!v.file || seen.has(v.file)) return false;
    seen.add(v.file); return true;
  });

  // Apply duration filter if specified
  if (minDur || maxDur) {
    const filtered = deduped.filter(v => {
      const d = v.duration || 0;
      const okMin = !minDur || d >= minDur;
      const okMax = !maxDur || d <= maxDur;
      return okMin && okMax;
    });
    // If filter is too strict and leaves nothing, return unfiltered but sorted by closeness
    if (filtered.length > 0) return filtered;
    // Fallback — sort by distance from target duration
    const target = minDur || 30;
    return deduped.sort((a, b) => Math.abs(a.duration - target) - Math.abs(b.duration - target));
  }

  return deduped;
}

// ── Score video ────────────────────────────────────────────
function scoreClip(v, minDur, maxDur) {
  let s = 0;
  const d = v.duration || 0;

  // Duration score — highest priority
  if (minDur && maxDur) {
    if (d >= minDur && d <= maxDur) s += 10;  // perfect range
    else if (d >= minDur * 0.8 && d <= maxDur * 1.2) s += 5;  // close
    else s -= 5;
  } else {
    if (d >= 30 && d <= 60) s += 6;
    else if (d >= 15 && d < 30) s += 2;
    else if (d < 10) s -= 3;
  }

  // Quality score
  if (v.fileWidth >= 3840) s += 5;       // 4K
  else if (v.fileWidth >= 1920) s += 3;  // 1080p
  else if (v.fileWidth >= 1280) s += 1;  // 720p

  // Orientation
  if (v.h > v.w) s += 3;  // portrait — best for reels

  // Has downloadable file
  if (v.file) s += 2;

  return s;
}

// ── Static files ───────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ── POST /api/ai ───────────────────────────────────────
  if (pathname === '/api/ai' && req.method === 'POST') {
    try {
      const body   = JSON.parse(await readBody(req));
      const result = await callAI(body.messages || [], body.system || '', body.max_tokens || 2000);
      json(200, result);
    } catch(e) { console.error('[AI]', e.message); json(500, { error: e.message }); }
    return;
  }

  // ── GET /api/videos — multi-source with duration filter ─
  if (pathname === '/api/videos') {
    const q      = query.q      || 'urban city night';
    const n      = Math.min(parseInt(query.n)      || 12, 20);
    const minDur = parseInt(query.minDur) || 0;
    const maxDur = parseInt(query.maxDur) || 0;
    const page   = parseInt(query.page)   || 0;

    try {
      let videos = await searchAll(q, n, minDur, maxDur, page || undefined);

      // If we still don't have enough, try one more page
      if (videos.length < 6) {
        const extra = await searchAll(q, n, minDur, maxDur, Math.floor(Math.random()*5)+1);
        const seen  = new Set(videos.map(v => v.file));
        extra.filter(v => v.file && !seen.has(v.file)).forEach(v => videos.push(v));
      }

      // Sort by score
      videos = videos
        .sort((a, b) => scoreClip(b, minDur, maxDur) - scoreClip(a, minDur, maxDur))
        .slice(0, n);

      json(200, {
        videos,
        sources: [...new Set(videos.map(v => v.source))],
        total:   videos.length,
      });
    } catch(e) { console.error('[Videos]', e.message); json(500, { error: e.message }); }
    return;
  }

  // ── GET /health ────────────────────────────────────────
  if (pathname === '/health') {
    json(200, {
      status:      'ok',
      ai_provider: AI_PROVIDER,
      groq:        !!GROQ_KEY,
      claude:      !!ANTHROPIC_KEY,
      pexels:      !!PEXELS_KEY,
      pixabay:     PIXABAY_ON,
    });
    return;
  }

  // ── GET /debug ─────────────────────────────────────────
  if (pathname === '/debug') {
    json(200, {
      ai_provider:    AI_PROVIDER,
      pexels:         !!PEXELS_KEY,
      pexels_prefix:  PEXELS_KEY   ? PEXELS_KEY.slice(0,8)+'...'   : 'NOT SET',
      pixabay:        PIXABAY_ON,
      pixabay_prefix: PIXABAY_KEY  ? PIXABAY_KEY.slice(0,8)+'...'  : 'NOT SET',
      groq:           !!GROQ_KEY,
      groq_prefix:    GROQ_KEY     ? GROQ_KEY.slice(0,8)+'...'     : 'NOT SET',
      claude:         !!ANTHROPIC_KEY,
      node:           process.version,
      port:           PORT,
    });
    return;
  }

  // ── GET /test-ai ───────────────────────────────────────
  if (pathname === '/test-ai') {
    try {
      const r = await callAI([{ role: 'user', content: 'Say OK only.' }], 'Reply with only OK.', 16);
      json(200, { provider: AI_PROVIDER, response: r?.content?.[0]?.text || '', status: 'working' });
    } catch(e) { json(500, { provider: AI_PROVIDER, error: e.message }); }
    return;
  }

  // ── Static files ───────────────────────────────────────
  const file = (pathname === '/' || pathname === '/index.html')
    ? path.join(__dirname, 'index.html')
    : path.join(__dirname, pathname.replace(/\.\./g, ''));
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveStatic(res, file);

}).listen(PORT, () => {
  console.log(`\n  ✅  REEL OS v5`);
  console.log(`  🤖  AI      : ${AI_PROVIDER.toUpperCase()}`);
  console.log(`  🎬  Pexels  : ${PEXELS_KEY  ? 'loaded ✓' : 'NOT SET ⚠️'}`);
  console.log(`  🎥  Pixabay : ${PIXABAY_ON  ? 'enabled ✓' : 'not set (add PIXABAY_KEY to enable)'}`);
  console.log(`  ⚡  Groq    : ${GROQ_KEY    ? 'loaded ✓' : 'NOT SET ⚠️'}`);
  console.log(`  🧠  Claude  : ${ANTHROPIC_KEY ? 'loaded ✓' : 'disabled'}`);
  console.log(`  🚀  Port    : ${PORT}\n`);
});
