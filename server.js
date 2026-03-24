// REEL OS — Server v3
// Fresh content engine: multi-source videos, query variation, trending, history
//
// Render env vars:
//   PEXELS_KEY       — required (pexels.com/api)
//   PIXABAY_KEY      — optional (pixabay.com/api)
//   GROQ_KEY         — required when AI_PROVIDER=groq (default, free)
//   ANTHROPIC_KEY    — required when AI_PROVIDER=claude
//   AI_PROVIDER      — 'groq' (default) or 'claude'

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

// ── History store (in-memory, resets on redeploy) ──────────
// For persistent history across restarts, use a file or DB
const history = {
  scripts:  [],   // last 30 generated scripts (topic+hook combinations)
  queries:  {},   // last used page offsets per query
  maxSize:  30,
};

function addToHistory(topic, hook, queries) {
  history.scripts.unshift({ topic, hook, queries, ts: Date.now() });
  if (history.scripts.length > history.maxSize) history.scripts.pop();
}

function getRecentHooks(topic) {
  return history.scripts
    .filter(s => s.topic === topic)
    .slice(0, 5)
    .map(s => s.hook);
}

function getRecentQueries(topic) {
  return history.scripts
    .filter(s => s.topic === topic)
    .slice(0, 3)
    .flatMap(s => s.queries || []);
}

// ── Random page offset per query (never same results) ──────
function getPageOffset(query) {
  // Random page 1-5, biased toward freshness
  const page = Math.floor(Math.random() * 5) + 1;
  history.queries[query] = page;
  return page;
}

// ── HTTPS helpers ──────────────────────────────────────────
function httpsPost(hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      { hostname, path: reqPath, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
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

function httpsGet(hostname, reqPath, headers) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: reqPath, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Parse error: ' + raw.slice(0,100))); }
      });
    }).on('error', reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) reject(new Error('Too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── AI providers ───────────────────────────────────────────
async function callGroq(messages, system, maxTokens) {
  if (!GROQ_KEY) throw new Error('GROQ_KEY not set. Get a free key at console.groq.com');
  const result = await httpsPost(
    'api.groq.com', '/openai/v1/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    { model: 'llama-3.3-70b-versatile', max_tokens: maxTokens || 1500,
      temperature: 0.85, messages: [{ role: 'system', content: system }, ...messages] }
  );
  if (result.status !== 200) {
    throw new Error('Groq: ' + (result.body?.error?.message || JSON.stringify(result.body).slice(0,200)));
  }
  return { content: [{ type: 'text', text: result.body?.choices?.[0]?.message?.content || '{}' }] };
}

async function callClaude(messages, system, maxTokens) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY not set or no credits. Check console.anthropic.com');
  const result = await httpsPost(
    'api.anthropic.com', '/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    { model: 'claude-sonnet-4-5', max_tokens: maxTokens || 1500, system, messages }
  );
  if (result.status !== 200) {
    throw new Error('Claude: ' + (result.body?.error?.message || JSON.stringify(result.body).slice(0,200)));
  }
  return result.body;
}

async function callAI(messages, system, maxTokens) {
  return AI_PROVIDER === 'claude'
    ? callClaude(messages, system, maxTokens)
    : callGroq(messages, system, maxTokens);
}

// ── Video sources ──────────────────────────────────────────

// Pexels — random page offset for fresh results
async function searchPexels(query, n) {
  if (!PEXELS_KEY) return [];
  const page = getPageOffset(query);
  const qs   = new URLSearchParams({ query, per_page: n, size: 'medium', page });
  try {
    const data = await httpsGet('api.pexels.com', `/videos/search?${qs}`, { Authorization: PEXELS_KEY });
    return (data.videos || []).map(v => ({
      id: 'px_'+v.id, source: 'Pexels',
      url:  v.url, duration: v.duration, thumb: v.image,
      file: v.video_files?.find(f => f.quality==='sd' && f.width<=1280)?.link || v.video_files?.[0]?.link,
      photographer: v.user?.name || 'Pexels',
      w: v.width, h: v.height,
    }));
  } catch(e) { console.warn('[Pexels]', e.message); return []; }
}

// Pixabay — free, no attribution required
async function searchPixabay(query, n) {
  if (!PIXABAY_KEY) return [];
  const qs = new URLSearchParams({
    key: PIXABAY_KEY, q: query, video_type: 'film',
    per_page: n, page: Math.floor(Math.random()*4)+1,
  });
  try {
    const data = await httpsGet('pixabay.com', `/api/videos/?${qs}`, {});
    return (data.hits || []).map(v => ({
      id: 'pb_'+v.id, source: 'Pixabay',
      url:  `https://pixabay.com/videos/id-${v.id}/`,
      duration: v.duration,
      thumb: v.videos?.medium?.thumbnail || v.videos?.small?.thumbnail,
      file:  v.videos?.medium?.url       || v.videos?.small?.url,
      photographer: v.user || 'Pixabay',
      w: v.videos?.medium?.width  || 1280,
      h: v.videos?.medium?.height || 720,
    }));
  } catch(e) { console.warn('[Pixabay]', e.message); return []; }
}

// Coverr — free stock video API (no key needed)
async function searchCoverr(query, n) {
  try {
    const qs   = new URLSearchParams({ q: query, per_page: n });
    const data = await httpsGet('api.coverr.co', `/videos?${qs}`, { 'coverr-token': 'coverr-public' });
    return ((data.hits || data.items || [])).slice(0, n).map(v => ({
      id: 'co_'+(v.id||v.slug), source: 'Coverr',
      url:   v.url  || `https://coverr.co/videos/${v.slug}`,
      duration: v.duration || 10,
      thumb: v.preview_image_url || v.thumbnail,
      file:  v.mp4_url || (v.urls && (v.urls.mp4_sd || v.urls.mp4)),
      photographer: 'Coverr',
      w: 1280, h: 720,
    }));
  } catch(e) { console.warn('[Coverr]', e.message); return []; }
}

// Multi-source: search all in parallel, merge & deduplicate
async function searchAllSources(query, n) {
  const [pexels, pixabay, coverr] = await Promise.all([
    searchPexels(query, n),
    searchPixabay(query, Math.ceil(n/2)),
    searchCoverr(query, Math.ceil(n/2)),
  ]);
  // Interleave sources for variety
  const merged = [];
  const maxLen = Math.max(pexels.length, pixabay.length, coverr.length);
  for (let i = 0; i < maxLen; i++) {
    if (pexels[i])  merged.push(pexels[i]);
    if (pixabay[i]) merged.push(pixabay[i]);
    if (coverr[i])  merged.push(coverr[i]);
  }
  // Deduplicate by file URL
  const seen = new Set();
  return merged.filter(v => {
    if (!v.file || seen.has(v.file)) return false;
    seen.add(v.file); return true;
  }).slice(0, n * 2); // return up to 2x results for scoring
}

// ── Static files ───────────────────────────────────────────
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

  res.setHeader('Access-Control-Allow-Origin',  '*');
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
      const result = await callAI(body.messages || [], body.system || '', body.max_tokens || 1500);
      json(200, result);
    } catch(e) {
      console.error('[AI]', e.message);
      json(500, { error: e.message });
    }
    return;
  }

  // ── GET /api/videos — multi-source with random offset ─
  if (pathname === '/api/videos') {
    const q = query.q || 'urban city';
    const n = Math.min(parseInt(query.n) || 6, 10);
    try {
      const videos = await searchAllSources(q, n);
      json(200, { videos, sources: [...new Set(videos.map(v => v.source))] });
    } catch(e) { json(500, { error: e.message }); }
    return;
  }

  // ── GET /api/history ───────────────────────────────────
  if (pathname === '/api/history') {
    json(200, { count: history.scripts.length, recent: history.scripts.slice(0, 10) });
    return;
  }

  // ── POST /api/history — save generated script ─────────
  if (pathname === '/api/history' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      addToHistory(body.topic, body.hook, body.queries);
      json(200, { saved: true, total: history.scripts.length });
    } catch(e) { json(500, { error: e.message }); }
    return;
  }

  // ── GET /api/context — history context for AI ─────────
  if (pathname === '/api/context') {
    const topic = query.topic || '';
    json(200, {
      recentHooks:   getRecentHooks(topic),
      recentQueries: getRecentQueries(topic),
      totalGenerated: history.scripts.length,
    });
    return;
  }

  // ── GET /health ────────────────────────────────────────
  if (pathname === '/health') {
    json(200, {
      status: 'ok', ai_provider: AI_PROVIDER,
      groq: !!GROQ_KEY, claude: !!ANTHROPIC_KEY,
      pexels: !!PEXELS_KEY, pixabay: !!PIXABAY_KEY,
    });
    return;
  }

  // ── GET /debug ─────────────────────────────────────────
  if (pathname === '/debug') {
    json(200, {
      ai_provider:       AI_PROVIDER,
      pexels_key_set:    !!PEXELS_KEY,
      pixabay_key_set:   !!PIXABAY_KEY,
      groq_key_set:      !!GROQ_KEY,
      claude_key_set:    !!ANTHROPIC_KEY,
      groq_prefix:       GROQ_KEY      ? GROQ_KEY.slice(0,8)+'...'      : 'NOT SET',
      pexels_prefix:     PEXELS_KEY    ? PEXELS_KEY.slice(0,8)+'...'    : 'NOT SET',
      history_count:     history.scripts.length,
      node_version:      process.version,
      port:              PORT,
    });
    return;
  }

  // ── GET /test-ai ───────────────────────────────────────
  if (pathname === '/test-ai') {
    try {
      const result = await callAI(
        [{ role: 'user', content: 'Reply with only the word OK.' }],
        'Reply with only OK.', 16
      );
      json(200, { provider: AI_PROVIDER, response: result?.content?.[0]?.text || '', status: 'working' });
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
  console.log(`\n  ✅  REEL OS v3 on port ${PORT}`);
  console.log(`  🤖  AI       : ${AI_PROVIDER.toUpperCase()}`);
  console.log(`  🎬  Pexels   : ${PEXELS_KEY   ? 'loaded ✓' : 'NOT SET ⚠️'}`);
  console.log(`  🎥  Pixabay  : ${PIXABAY_KEY  ? 'loaded ✓' : 'not set (optional)'}`);
  console.log(`  ⚡  Groq     : ${GROQ_KEY     ? 'loaded ✓' : 'NOT SET ⚠️'}`);
  console.log(`  🧠  Claude   : ${ANTHROPIC_KEY? 'loaded ✓' : 'disabled (add credits to enable)'}\n`);
});
