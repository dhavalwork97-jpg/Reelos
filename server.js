// REEL OS — Server
// AI provider is selected by the AI_PROVIDER env variable:
//   AI_PROVIDER=groq    → uses Groq (free, default)
//   AI_PROVIDER=claude  → uses Anthropic Claude (requires credits)
//
// Render env vars:
//   PEXELS_KEY      — always required
//   GROQ_KEY        — required when AI_PROVIDER=groq  (free at console.groq.com)
//   ANTHROPIC_KEY   — required when AI_PROVIDER=claude

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT          = process.env.PORT          || 3000;
const PEXELS_KEY    = process.env.PEXELS_KEY    || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const GROQ_KEY      = process.env.GROQ_KEY      || '';
// Default to groq. Switch to 'claude' in Render env once you add Anthropic credits.
const AI_PROVIDER   = (process.env.AI_PROVIDER  || 'groq').toLowerCase();

// ── HTTPS POST ─────────────────────────────────────────────
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

// ── HTTPS GET ──────────────────────────────────────────────
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

// ── AI: Groq ──────────────────────────────────────────────
async function callGroq(messages, system, maxTokens) {
  if (!GROQ_KEY) throw new Error('GROQ_KEY not set in Render environment variables. Get a free key at console.groq.com');
  const body = {
    model: 'llama-3.3-70b-versatile',
    max_tokens: maxTokens || 1000,
    messages: [
      { role: 'system', content: system },
      ...messages
    ],
    temperature: 0.7,
  };
  console.log('[Groq] Sending request...');
  const result = await httpsPost(
    'api.groq.com',
    '/openai/v1/chat/completions',
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
    body
  );
  console.log('[Groq] Status:', result.status);
  if (result.status !== 200) {
    const errMsg = result.body?.error?.message || JSON.stringify(result.body).slice(0, 300);
    throw new Error('Groq error: ' + errMsg);
  }
  // Return in Anthropic-compatible shape so frontend works with both
  const text = result.body?.choices?.[0]?.message?.content || '{}';
  return { content: [{ type: 'text', text }] };
}

// ── AI: Claude ────────────────────────────────────────────
async function callClaude(messages, system, maxTokens) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY not set. Add it in Render → Environment, then set AI_PROVIDER=claude');
  const body = { model: 'claude-sonnet-4-5', max_tokens: maxTokens || 1000, system, messages };
  console.log('[Claude] Sending request...');
  const result = await httpsPost(
    'api.anthropic.com',
    '/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body
  );
  console.log('[Claude] Status:', result.status);
  if (result.status !== 200) {
    const errMsg = result.body?.error?.message || JSON.stringify(result.body).slice(0, 300);
    throw new Error('Claude error: ' + errMsg);
  }
  return result.body;
}

// ── Route AI to active provider ────────────────────────────
async function callAI(messages, system, maxTokens) {
  if (AI_PROVIDER === 'claude') {
    return callClaude(messages, system, maxTokens);
  }
  return callGroq(messages, system, maxTokens);
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

  // ── POST /api/ai — unified AI endpoint ────────────────
  if (pathname === '/api/ai' && req.method === 'POST') {
    try {
      const body     = JSON.parse(await readBody(req));
      const messages = body.messages || [];
      const system   = body.system   || 'You are a helpful assistant.';
      const maxTok   = body.max_tokens || 1000;
      const result   = await callAI(messages, system, maxTok);
      json(200, result);
    } catch(e) {
      console.error('[AI] Error:', e.message);
      json(500, { error: e.message });
    }
    return;
  }

  // ── GET /api/videos — Pexels proxy ────────────────────
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

  // ── GET /health ────────────────────────────────────────
  if (pathname === '/health') {
    json(200, {
      status:      'ok',
      ai_provider: AI_PROVIDER,
      groq:        !!GROQ_KEY,
      claude:      !!ANTHROPIC_KEY,
      pexels:      !!PEXELS_KEY,
    });
    return;
  }

  // ── GET /debug ─────────────────────────────────────────
  if (pathname === '/debug') {
    json(200, {
      ai_provider:        AI_PROVIDER,
      pexels_key_set:     !!PEXELS_KEY,
      pexels_key_prefix:  PEXELS_KEY     ? PEXELS_KEY.slice(0,8)+'...'     : 'NOT SET',
      groq_key_set:       !!GROQ_KEY,
      groq_key_prefix:    GROQ_KEY       ? GROQ_KEY.slice(0,8)+'...'       : 'NOT SET',
      claude_key_set:     !!ANTHROPIC_KEY,
      claude_key_prefix:  ANTHROPIC_KEY  ? ANTHROPIC_KEY.slice(0,8)+'...'  : 'NOT SET',
      node_version:       process.version,
      port:               PORT,
    });
    return;
  }

  // ── GET /test-ai — quick AI test ──────────────────────
  if (pathname === '/test-ai') {
    try {
      const result = await callAI(
        [{ role: 'user', content: 'Reply with only the word OK and nothing else.' }],
        'You are a test assistant. Reply with only OK.',
        16
      );
      const text = result?.content?.[0]?.text || '';
      json(200, { provider: AI_PROVIDER, response: text, status: 'working' });
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
  console.log(`\n  ✅  REEL OS on port ${PORT}`);
  console.log(`  🤖  AI Provider : ${AI_PROVIDER.toUpperCase()}`);
  console.log(`  🔑  Pexels      : ${PEXELS_KEY     ? 'loaded ✓' : 'NOT SET ⚠️'}`);
  console.log(`  ⚡  Groq        : ${GROQ_KEY       ? 'loaded ✓' : 'NOT SET ⚠️'}`);
  console.log(`  🧠  Claude      : ${ANTHROPIC_KEY  ? 'loaded ✓' : 'NOT SET (disabled)'}`)
  console.log(`\n  To switch to Claude: set AI_PROVIDER=claude in Render env\n`);
});
