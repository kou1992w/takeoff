/* 外構積算 拾いツール — ローカルサーバー(依存ライブラリなし/Node標準のみ)
 * 同期済みGoogle Driveフォルダを毎日スキャンして配置図PDFの現場一覧を保持し、
 * アプリ本体・現場一覧(API)・配置図PDFを配信する。
 *   起動:  node server.js
 *   閲覧:  http://localhost:5050
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

// ===== .env 読み込み(依存なし) =====
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch { }
}
loadEnv();
const ALLOWLIST = (process.env.ALLOWLIST || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ===== 認証(Googleログイン + 許可リスト) =====
// GOOGLE_CLIENT_ID 等が未設定ならローカル動作優先で認証は無効(従来どおり)。
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.OAUTH_REDIRECT);
function parseCookies(req) { const o = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
function cookie(name, val, maxAge) { return `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function sessionCookie(email) {
  const data = `${email}|${Date.now() + 7 * 864e5}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('hex');
  return cookie('sess', `${data}|${sig}`, 7 * 86400);
}
function verifySession(v) {
  if (!v) return null;
  const parts = v.split('|'); if (parts.length !== 3) return null;
  const [email, exp, sig] = parts;
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(`${email}|${exp}`).digest('hex');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Number(exp) < Date.now()) return null;
  if (!ALLOWLIST.includes(email)) return null;
  return { email };
}
function httpsPostForm(host, pathname, form) {
  return new Promise((resolve, reject) => {
    const data = new url.URLSearchParams(form).toString();
    const r = https.request({ host, path: pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, resp => {
      let b = ''; resp.on('data', c => b += c); resp.on('end', () => resolve(b));
    });
    r.on('error', reject); r.write(data); r.end();
  });
}
function authLogin(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new url.URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.OAUTH_REDIRECT, response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account' });
  res.writeHead(302, { 'Set-Cookie': cookie('oauth_state', state, 600), Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
  res.end();
}
async function authCallback(req, res, u) {
  try {
    const { code, state } = u.query;
    if (!code || !state || state !== parseCookies(req).oauth_state) { res.writeHead(400); return res.end('bad state'); }
    const tok = JSON.parse(await httpsPostForm('oauth2.googleapis.com', '/token', {
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: process.env.OAUTH_REDIRECT, grant_type: 'authorization_code',
    }));
    if (!tok.id_token) throw new Error('no id_token');
    const payload = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8'));
    const email = (payload.email || '').toLowerCase();
    if (!payload.email_verified || !ALLOWLIST.includes(email)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>アクセスが許可されていません</h2><p>${email || 'このアカウント'} は利用を許可されていません。</p><p><a href="/auth/logout">別のアカウントでログイン</a></p></body>`);
    }
    res.writeHead(302, { 'Set-Cookie': [cookie('oauth_state', '', 0), sessionCookie(email)], Location: '/' });
    res.end();
  } catch (e) { res.writeHead(500); res.end('auth error'); }
}
function authLogout(req, res) { res.writeHead(302, { 'Set-Cookie': cookie('sess', '', 0), Location: '/auth/login' }); res.end(); }

// ===== 設定 =====
const PORT = parseInt(process.env.PORT, 10) || 5050;
const BASE = process.env.BASE_DIR || 'I:/マイドライブ/A1現場情報';  // ローカルfsモードの現場フォルダ
const RCLONE_REMOTE = process.env.RCLONE_REMOTE || ''; // 例: "gdrive:" 。設定時はクラウド(rclone)モード、未設定ならローカルfs
const RCLONE_CONF = process.env.RCLONE_CONF || '';     // rclone.conf のパス(任意)
function rcloneArgs(extra) { const a = extra.slice(); if (RCLONE_CONF) a.push('--config', RCLONE_CONF); return a; }
const CACHE = path.join(__dirname, 'sites.json'); // 現場一覧キャッシュ
const SAVES = path.join(__dirname, 'saves');      // 現場ごとの作図データ保存先
const RESCAN_MS = 12 * 60 * 60 * 1000;            // 12hごとに再スキャン
try { fs.mkdirSync(SAVES); } catch { }
function savePath(key) { return path.join(SAVES, crypto.createHash('sha1').update(String(key)).digest('hex') + '.json'); }

// ===== 費用算出(係数制度)の設定 =====
// 姉妹プロジェクト「費用算出」の仕様に準拠。標準現場・棟数1で 450,000円。
const COST_CFG = path.join(__dirname, 'cost-settings.json');
const DEFAULT_COST = {
  fixed: 10000, base: 440000,                          // 固定費 / 係数対象金額
  std: { asphalt: 60, garden: 25, blockPt: 25.5 },     // 標準値(1棟あたり)
  alloc: { asphalt: 0.60, block: 0.25, garden: 0.15 }, // 最終係数への配分
  coefBase: 1, coefTsumi: 1,                            // ベース係数 / 積み係数
  adj: { asphalt: 1, block: 1, garden: 1 },            // 調整率(0〜1。1=単純比例)
  gravelRatio: 0.5,                                    // 砕石→アスファルト換算率(砕石㎡×これをアス係数に算入)
};
function loadCostSettings() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(COST_CFG, 'utf8')); } catch { }
  const D = DEFAULT_COST, num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  return {
    fixed: num(s.fixed, D.fixed), base: num(s.base, D.base),
    std: { asphalt: num(s.std && s.std.asphalt, D.std.asphalt), garden: num(s.std && s.std.garden, D.std.garden), blockPt: num(s.std && s.std.blockPt, D.std.blockPt) },
    alloc: { asphalt: num(s.alloc && s.alloc.asphalt, D.alloc.asphalt), block: num(s.alloc && s.alloc.block, D.alloc.block), garden: num(s.alloc && s.alloc.garden, D.alloc.garden) },
    coefBase: num(s.coefBase, D.coefBase), coefTsumi: num(s.coefTsumi, D.coefTsumi),
    adj: { asphalt: num(s.adj && s.adj.asphalt, D.adj.asphalt), block: num(s.adj && s.adj.block, D.adj.block), garden: num(s.adj && s.adj.garden, D.adj.garden) },
    gravelRatio: num(s.gravelRatio, D.gravelRatio),
  };
}

let sites = [];

// ===== 配置図スキャン =====
// 構造: BASE/<地域>/<日付_現場名>/<棟>/(原図)配置図_*.pdf
function walk(dir, hits) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hits);
    else if (e.isFile() && /配置図.*\.pdf$/i.test(e.name) && !/見取|求積/.test(e.name)) hits.push(p);
  }
}
function scan() {
  const groups = {};
  if (RCLONE_REMOTE) {
    // クラウド(rclone): リモート配下の全ファイルを取得してグループ化
    let arr = [];
    try {
      arr = JSON.parse(execFileSync('rclone', rcloneArgs(['lsjson', RCLONE_REMOTE, '-R', '--files-only']), { maxBuffer: 128 * 1024 * 1024 }).toString());
    } catch (e) { console.error('[scan] rclone lsjson 失敗:', e.message); }
    const tos = {};                                          // 現場key -> 配置図を持つ棟フォルダの集合(棟数算出用)
    for (const it of arr) {
      const p = it.Path;                                     // 例: 鶴岡/日付_現場名/1号棟/(原図)配置図_*.pdf
      if (!/配置図.*\.pdf$/i.test(p) || /見取|求積/.test(p)) continue;
      const seg = p.split('/'); if (seg.length < 3) continue;
      const file = seg[seg.length - 1], site = seg[seg.length - 3], to = seg[seg.length - 2];
      const region = seg.length >= 4 ? seg[seg.length - 4] : '';
      const key = seg.slice(0, seg.length - 2).join('/');     // 現場フォルダ(棟の1つ上)
      (tos[key] = tos[key] || new Set()).add(to);             // 棟フォルダを数える
      const score = (/原図/.test(file) ? 2 : 0) + (/1号棟|１号棟/.test(file) ? 1 : 0);
      if (!groups[key] || score > groups[key].score) groups[key] = { region, site, score, key, path: p };
    }
    sites = Object.values(groups)
      .map((g, i) => ({ id: String(i + 1), key: g.key, region: g.region, site: g.site, path: g.path, buildings: (tos[g.key] || new Set()).size || 1 }))
      .sort((a, b) => a.site.localeCompare(b.site, 'ja'));
  } else {
    // ローカルfs
    const hits = []; walk(BASE, hits);
    const tos = {};
    for (const f of hits) {
      const siteDir = path.dirname(path.dirname(f));          // 棟の1つ上
      const region = path.basename(path.dirname(siteDir)), site = path.basename(siteDir);
      (tos[siteDir] = tos[siteDir] || new Set()).add(path.basename(path.dirname(f)));
      const score = (/原図/.test(f) ? 2 : 0) + (/1号棟|１号棟/.test(f) ? 1 : 0);
      if (!groups[siteDir] || score > groups[siteDir].score) groups[siteDir] = { region, site, file: f, score, dir: siteDir };
    }
    sites = Object.values(groups)
      .map((g, i) => ({ id: String(i + 1), key: g.dir, region: g.region, site: g.site, file: g.file, buildings: (tos[g.dir] || new Set()).size || 1 }))
      .sort((a, b) => a.site.localeCompare(b.site, 'ja'));
  }
  fs.writeFileSync(CACHE, JSON.stringify({ scannedAt: new Date().toISOString(), sites }, null, 2));
  console.log(`[scan] ${sites.length} 現場 (${new Date().toLocaleString('ja-JP')})`);
}
function loadCacheOrScan() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    sites = c.sites || [];
    if (Date.now() - new Date(c.scannedAt).getTime() > RESCAN_MS) scan();
  } catch { scan(); }
}

// ===== HTTP =====
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  // --- 認証ルート ---
  if (u.pathname === '/auth/login') return AUTH_ENABLED ? authLogin(req, res) : (res.writeHead(302, { Location: '/' }), res.end());
  if (u.pathname === '/auth/callback') return authCallback(req, res, u);
  if (u.pathname === '/auth/logout') return authLogout(req, res);
  // --- 認証ゲート(許可リスト) ---
  if (AUTH_ENABLED && !verifySession(parseCookies(req).sess)) {
    if (u.pathname.startsWith('/api/')) { res.writeHead(401); return res.end('login required'); }
    res.writeHead(302, { Location: '/auth/login' }); return res.end();
  }
  if (u.pathname === '/' || u.pathname === '/index.html') return serveFile(res, path.join(__dirname, 'index.html'));
  if (u.pathname === '/app.js') return serveFile(res, path.join(__dirname, 'app.js'));
  if (u.pathname === '/style.css') return serveFile(res, path.join(__dirname, 'style.css'));
  if (u.pathname === '/api/sites') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ sites }));
  }
  if (u.pathname === '/api/rescan') { scan(); res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/api/load') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    try { return res.end(fs.readFileSync(savePath(u.query.key), 'utf8')); } catch { return res.end('{}'); }
  }
  if (u.pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 30e6) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        const rec = j.data || {};
        if (j.quantities) rec.quantities = j.quantities;   // 費用算出用の数量サマリも保存
        rec.savedAt = Date.now();
        fs.writeFileSync(savePath(j.key), JSON.stringify(rec));
        res.writeHead(200); res.end('ok');
      }
      catch { res.writeHead(400); res.end('bad'); }
    });
    return;
  }
  // --- 費用管理 ---
  if (u.pathname === '/cost' || u.pathname === '/cost.html') return serveFile(res, path.join(__dirname, 'cost.html'));
  if (u.pathname === '/cost.js') return serveFile(res, path.join(__dirname, 'cost.js'));
  if (u.pathname === '/api/costsettings') {
    if (req.method === 'POST') {
      let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { fs.writeFileSync(COST_CFG, JSON.stringify(JSON.parse(b))); res.writeHead(200); res.end('ok'); } catch { res.writeHead(400); res.end('bad'); } });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify(loadCostSettings()));
  }
  if (u.pathname === '/api/costsites') {
    const out = sites.map(s => {
      let quantities = null, savedAt = null;
      try { const rec = JSON.parse(fs.readFileSync(savePath(s.key), 'utf8')); quantities = rec.quantities || null; savedAt = rec.savedAt || null; } catch { }
      return { id: s.id, site: s.site, region: s.region, key: s.key, buildings: s.buildings || 1, quantities, savedAt };
    });
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ sites: out, settings: loadCostSettings() }));
  }
  if (u.pathname === '/api/pdf') {
    const s = sites.find(x => x.id === u.query.id);
    if (!s) { res.writeHead(404); return res.end('no site'); }
    if (RCLONE_REMOTE && s.path) {           // クラウド: rcloneでPDFを取り出してストリーム
      res.writeHead(200, { 'Content-Type': MIME['.pdf'] });
      const ps = spawn('rclone', rcloneArgs(['cat', RCLONE_REMOTE + s.path]));
      ps.stdout.pipe(res);
      ps.on('error', () => { try { res.destroy(); } catch { } });
      return;
    }
    return serveFile(res, s.file);
  }
  res.writeHead(404); res.end('not found');
});

loadCacheOrScan();
setInterval(scan, RESCAN_MS);
server.listen(PORT, () => console.log(`外構図作成: http://localhost:${PORT}  (現場 ${sites.length}件 / 認証 ${AUTH_ENABLED ? 'ON' : 'OFF'})`));
