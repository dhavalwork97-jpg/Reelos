// REEL OS — Server v4 — Scene-Match Engine
// Every video is scored against the exact mood, pace, and energy of its scene
//
// Render env vars:
//   PEXELS_KEY      — required
//   GROQ_KEY        — required (free at console.groq.com)
//   ANTHROPIC_KEY   — optional, set AI_PROVIDER=claude to activate
//   AI_PROVIDER     — 'groq' (default) | 'claude'
//   PIXABAY_KEY     — optional (disabled by default, rate-limits quickly)

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT          = process.env.PORT          || 3000;
const PEXELS_KEY    = process.env.PEXELS_KEY    || '';
const GROQ_KEY      = process.env.GROQ_KEY      || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';
const AI_PROVIDER   = (process.env.AI_PROVIDER  || 'groq').toLowerCase();
// Pixabay disabled by default — enable by setting PIXABAY_KEY + PIXABAY_ENABLE=true
const PIXABAY_KEY    = process.env.PIXABAY_KEY    || '';
const PIXABAY_ENABLE = process.env.PIXABAY_ENABLE === 'true';

// ── History ────────────────────────────────────────────────
const history = { scripts: [], maxSize: 30 };
function addToHistory(e) {
  history.scripts.unshift({ ...e, ts: Date.now() });
  if (history.scripts.length > history.maxSize) history.scripts.pop();
}
function getRecentHooks(topic)   { return history.scripts.filter(s=>s.topic===topic).slice(0,5).map(s=>s.hookStyle); }
function getRecentQueries(topic) { return history.scripts.filter(s=>s.topic===topic).slice(0,3).flatMap(s=>s.queries||[]); }

// ── HTTPS helpers ──────────────────────────────────────────
function httpsPost(hostname, reqPath, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request(
      { hostname, path: reqPath, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } },
      res => { let r=''; res.on('data',c=>r+=c); res.on('end',()=>{ try{resolve({status:res.statusCode,body:JSON.parse(r)})}catch(e){resolve({status:res.statusCode,body:r})} }); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}
function httpsGet(hostname, reqPath, headers={}) {
  return new Promise((resolve, reject) => {
    https.get({ hostname, path: reqPath, headers }, res => {
      let r=''; res.on('data',c=>r+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(r))}catch(e){reject(new Error('Parse error'))} });
    }).on('error', reject);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d='';
    req.on('data',c=>{ d+=c; if(d.length>2e6) reject(new Error('Too large')); });
    req.on('end',()=>resolve(d)); req.on('error',reject);
  });
}

// ── AI providers ───────────────────────────────────────────
async function callGroq(messages, system, maxTokens) {
  if (!GROQ_KEY) throw new Error('GROQ_KEY not set. Get a free key at console.groq.com');
  const result = await httpsPost(
    'api.groq.com', '/openai/v1/chat/completions',
    { 'Content-Type':'application/json', 'Authorization':`Bearer ${GROQ_KEY}` },
    { model:'llama-3.3-70b-versatile', max_tokens:maxTokens||2000, temperature:0.85,
      messages:[{role:'system',content:system},...messages] }
  );
  if (result.status!==200) throw new Error('Groq: '+(result.body?.error?.message||JSON.stringify(result.body).slice(0,200)));
  return { content:[{type:'text',text:result.body?.choices?.[0]?.message?.content||'{}'}] };
}
async function callClaude(messages, system, maxTokens) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_KEY not set or no credits');
  const result = await httpsPost(
    'api.anthropic.com', '/v1/messages',
    { 'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01' },
    { model:'claude-sonnet-4-5', max_tokens:maxTokens||2000, system, messages }
  );
  if (result.status!==200) throw new Error('Claude: '+(result.body?.error?.message||JSON.stringify(result.body).slice(0,200)));
  return result.body;
}
async function callAI(messages, system, maxTokens) {
  return AI_PROVIDER==='claude' ? callClaude(messages,system,maxTokens) : callGroq(messages,system,maxTokens);
}

// ── Pick highest quality video file ──────────────────────────
// Priority: 4K (2160p) → HD (1080p) → qhd (1440p) → SD → first available
function pickBestFile(files) {
  if (!files || !files.length) return null;
  // Sort by width descending — widest = highest resolution
  const sorted = [...files].sort((a, b) => (b.width||0) - (a.width||0));
  // Prefer file with actual download link
  const withLink = sorted.filter(f => f.link);
  return withLink[0]?.link || sorted[0]?.link || null;
}

// ── Pick best thumbnail — highest res ─────────────────────
function pickBestThumb(v) {
  // Pexels image field is already the best thumbnail
  return v.image || null;
}

// ── Pexels search ──────────────────────────────────────────
async function searchPexels(query, n, page) {
  if (!PEXELS_KEY) return [];
  const pg = page || (Math.floor(Math.random()*5)+1);
  const qs = new URLSearchParams({ query, per_page:n, page:pg }); // no size filter = gets 4K results
  try {
    const data = await httpsGet('api.pexels.com', `/videos/search?${qs}`, { Authorization:PEXELS_KEY });
    return (data.videos||[]).map(v=>({
      id:'px_'+v.id, source:'Pexels',
      url:v.url, duration:v.duration, thumb:v.image,
      file: pickBestFile(v.video_files),  // picks 4K > HD > SD
      photographer:v.user?.name||'Pexels',
      w:v.width, h:v.height,
      tags: v.tags || [],
      quality: pickBestFile(v.video_files) ? 
        (v.video_files?.find(f=>f.link===pickBestFile(v.video_files))?.width >= 3840 ? '4K' :
         v.video_files?.find(f=>f.link===pickBestFile(v.video_files))?.width >= 1920 ? 'HD 1080p' :
         v.video_files?.find(f=>f.link===pickBestFile(v.video_files))?.width >= 1280 ? 'HD 720p' : 'SD') : 'SD',
      fileWidth: v.video_files?.find(f=>f.link===pickBestFile(v.video_files))?.width || v.width,
    }));
  } catch(e) { console.warn('[Pexels]',e.message); return []; }
}

async function searchPixabay(query, n) {
  if (!PIXABAY_KEY || !PIXABAY_ENABLE) return [];
  const qs = new URLSearchParams({ key:PIXABAY_KEY, q:query, video_type:'film', per_page:n, page:Math.floor(Math.random()*3)+1 });
  try {
    const data = await httpsGet('pixabay.com', `/api/videos/?${qs}`);
    return (data.hits||[]).map(v=>({
      id:'pb_'+v.id, source:'Pixabay',
      url:`https://pixabay.com/videos/id-${v.id}/`,
      duration:v.duration,
      thumb:v.videos?.medium?.thumbnail||v.videos?.small?.thumbnail,
      file:v.videos?.medium?.url||v.videos?.small?.url,
      photographer:v.user||'Pixabay',
      w:v.videos?.medium?.width||1280, h:v.videos?.medium?.height||720,
    }));
  } catch(e) { console.warn('[Pixabay]',e.message); return []; }
}

// ── Scene-aware video scorer ───────────────────────────────
// Scores each video against scene metadata: energy, pace, mood, shotType
function scoreVideoForScene(video, scene) {
  let score = 0;

  const energy = (scene.energy || 'medium').toLowerCase();   // low / medium / high
  const pace   = (scene.pace   || 'medium').toLowerCase();   // slow / medium / fast
  const mood   = (scene.mood   || '').toLowerCase();         // e.g. moody, bright, dark, warm
  const shot   = (scene.shotType || '').toLowerCase();       // wide / close / aerial / motion

  // Duration scoring — match to scene length
  const dur = video.duration || 0;
  const targetDur = scene.durationSec || 5;
  if (Math.abs(dur - targetDur) <= 3) score += 4;            // very close match
  else if (Math.abs(dur - targetDur) <= 6) score += 2;
  else if (dur < 3) score -= 3;                               // too short
  else if (dur > 45) score -= 2;                              // too long

  // Orientation — portrait best for reels
  if (video.h > video.w) score += 3;

  // Energy-based duration preference
  if (energy === 'high'   && dur >= 3  && dur <= 10) score += 2;
  if (energy === 'low'    && dur >= 8  && dur <= 20) score += 2;
  if (energy === 'medium' && dur >= 5  && dur <= 15) score += 1;

  // Pace matching via duration heuristic
  if (pace === 'fast' && dur <= 8)  score += 2;
  if (pace === 'slow' && dur >= 10) score += 2;

  // Boost if video has a downloadable file
  if (video.file) score += 2;

  return score;
}

function pickBestVideo(videos, scene) {
  if (!videos.length) return null;
  return [...videos].sort((a,b) => scoreVideoForScene(b,scene) - scoreVideoForScene(a,scene))[0];
}

// ── Multi-query search for one scene ──────────────────────
// Uses primary query + 2 fallback queries so we always find something
async function searchForScene(scene, extra) {
  const queries = [scene.query, ...(scene.fallbackQueries||[])].filter(Boolean);
  let allVideos = [];

  for (const q of queries) {
    const fullQ = extra ? `${q} ${extra}` : q;
    const [pexels, pixabay] = await Promise.all([
      searchPexels(fullQ, 8),
      PIXABAY_ENABLE ? searchPixabay(fullQ, 4) : Promise.resolve([]),
    ]);
    allVideos.push(...pexels, ...pixabay);
    if (allVideos.length >= 6) break; // enough to pick from
  }

  // Deduplicate
  const seen = new Set();
  allVideos = allVideos.filter(v => {
    if (!v.file || seen.has(v.file)) return false;
    seen.add(v.file); return true;
  });

  return allVideos;
}

// ── Static files ───────────────────────────────────────────
const MIME = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
function serveStatic(res, filePath) {
  const type = MIME[path.extname(filePath)]||'text/plain';
  fs.readFile(filePath,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':type});res.end(data);
  });
}

// ── HTTP Server ────────────────────────────────────────────
http.createServer(async (req, res) => {
  const {pathname, query} = url.parse(req.url, true);

  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS'){res.writeHead(204);res.end();return;}

  const json = (status,obj) => { res.writeHead(status,{'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); };

  // ── POST /api/ai ─────────────────────────────────────────
  if (pathname==='/api/ai' && req.method==='POST') {
    try {
      const body   = JSON.parse(await readBody(req));
      const result = await callAI(body.messages||[], body.system||'', body.max_tokens||2000);
      json(200, result);
    } catch(e) { console.error('[AI]',e.message); json(500,{error:e.message}); }
    return;
  }

  // ── POST /api/match-scene — score videos for a specific scene ──
  if (pathname==='/api/match-scene' && req.method==='POST') {
    try {
      const body  = JSON.parse(await readBody(req));
      const scene = body.scene || {};
      const extra = body.extra || '';
      const videos = await searchForScene(scene, extra);
      const picked = pickBestVideo(videos, scene);
      const alts   = videos.filter(v=>picked&&v.id!==picked.id).slice(0,5);
      json(200, { picked, alts, totalFound: videos.length });
    } catch(e) { console.error('[Match]',e.message); json(500,{error:e.message}); }
    return;
  }

  // ── GET /api/videos (legacy) ──────────────────────────────
  if (pathname==='/api/videos') {
    const q = query.q||'urban city';
    const n = Math.min(parseInt(query.n)||6,10);
    try {
      const videos = await searchPexels(q, n);
      json(200,{videos});
    } catch(e) { json(500,{error:e.message}); }
    return;
  }

  // ── POST /api/history ─────────────────────────────────────
  if (pathname==='/api/history' && req.method==='POST') {
    try { const b=JSON.parse(await readBody(req)); addToHistory(b); json(200,{saved:true}); }
    catch(e) { json(500,{error:e.message}); }
    return;
  }

  // ── GET /api/context ──────────────────────────────────────
  if (pathname==='/api/context') {
    const t = query.topic||'';
    json(200,{recentHooks:getRecentHooks(t),recentQueries:getRecentQueries(t),total:history.scripts.length});
    return;
  }

  // ── GET /health ───────────────────────────────────────────
  if (pathname==='/health') {
    json(200,{status:'ok',ai_provider:AI_PROVIDER,groq:!!GROQ_KEY,claude:!!ANTHROPIC_KEY,pexels:!!PEXELS_KEY,pixabay:PIXABAY_ENABLE&&!!PIXABAY_KEY});
    return;
  }

  // ── GET /debug ────────────────────────────────────────────
  if (pathname==='/debug') {
    json(200,{ai_provider:AI_PROVIDER,pexels:!!PEXELS_KEY,pexels_prefix:PEXELS_KEY?PEXELS_KEY.slice(0,8)+'...':'NOT SET',groq:!!GROQ_KEY,groq_prefix:GROQ_KEY?GROQ_KEY.slice(0,8)+'...':'NOT SET',claude:!!ANTHROPIC_KEY,pixabay_enabled:PIXABAY_ENABLE,history:history.scripts.length,node:process.version,port:PORT});
    return;
  }

  // ── GET /test-ai ──────────────────────────────────────────
  if (pathname==='/test-ai') {
    try {
      const r=await callAI([{role:'user',content:'Say OK only.'}],'Reply with only OK.',16);
      json(200,{provider:AI_PROVIDER,response:r?.content?.[0]?.text||'',status:'working'});
    } catch(e){json(500,{provider:AI_PROVIDER,error:e.message});}
    return;
  }

  // ── Static ────────────────────────────────────────────────
  const file=(pathname==='/'||pathname==='/index.html')
    ?path.join(__dirname,'index.html')
    :path.join(__dirname,pathname.replace(/\.\./g,''));
  if(!file.startsWith(__dirname)){res.writeHead(403);res.end('Forbidden');return;}
  serveStatic(res,file);

}).listen(PORT, ()=>{
  console.log(`\n  ✅  REEL OS v4 — Scene-Match Engine`);
  console.log(`  🤖  AI      : ${AI_PROVIDER.toUpperCase()}`);
  console.log(`  🎬  Pexels  : ${PEXELS_KEY?'loaded ✓':'NOT SET ⚠️'}`);
  console.log(`  ⚡  Groq    : ${GROQ_KEY?'loaded ✓':'NOT SET ⚠️'}`);
  console.log(`  🧠  Claude  : ${ANTHROPIC_KEY?'loaded ✓':'disabled'}`);
  console.log(`  🎥  Pixabay : ${PIXABAY_ENABLE?'enabled':'disabled (set PIXABAY_ENABLE=true to enable)'}`);
  console.log(`  🚀  Port    : ${PORT}\n`);
});
