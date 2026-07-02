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
// 許可リスト: allowlist.json を真として読む。無ければ .env ALLOWLIST から初期化して書き出す。
// 管理者ページから追加/削除でき、再起動なしで即反映される(letで保持)。
const ALLOW_FILE = path.join(__dirname, 'allowlist.json');
const normEmail = e => (e || '').trim().toLowerCase();
let ALLOWLIST = [];
function loadAllowlist() {
  try { ALLOWLIST = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')).map(normEmail).filter(Boolean); }
  catch {
    ALLOWLIST = (process.env.ALLOWLIST || '').split(',').map(normEmail).filter(Boolean);
    try { fs.writeFileSync(ALLOW_FILE, JSON.stringify(ALLOWLIST)); } catch { }
  }
}
function saveAllowlist() { ALLOWLIST = [...new Set(ALLOWLIST.map(normEmail).filter(Boolean))]; fs.writeFileSync(ALLOW_FILE, JSON.stringify(ALLOWLIST)); }
loadAllowlist();
const OWNER = normEmail(process.env.OWNER);   // 大元アカウント(管理者ページ専用)

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
// OAuthのリダイレクト先: アクセスされたホスト名から組み立てる(複数ドメイン対応)。取れなければenvを使用。
function redirectUri(req) { const host = req.headers.host; return host ? `https://${host}/auth/callback` : process.env.OAUTH_REDIRECT; }
function authLogin(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new url.URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(req), response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account' });
  res.writeHead(302, { 'Set-Cookie': cookie('oauth_state', state, 600), Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
  res.end();
}
async function authCallback(req, res, u) {
  try {
    const { code, state } = u.query;
    if (!code || !state || state !== parseCookies(req).oauth_state) { res.writeHead(400); return res.end('bad state'); }
    const tok = JSON.parse(await httpsPostForm('oauth2.googleapis.com', '/token', {
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(req), grant_type: 'authorization_code',
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
function sessionEmail(req) { const s = verifySession(parseCookies(req).sess); return s ? s.email : null; }
function isOwner(req) { return AUTH_ENABLED ? (!!OWNER && sessionEmail(req) === OWNER) : true; }   // 認証OFF(ローカル)では常に許可

// ===== 設定 =====
const PORT = parseInt(process.env.PORT, 10) || 5050;
const BASE = process.env.BASE_DIR || 'I:/マイドライブ/A1現場情報';  // ローカルfsモードの現場フォルダ
const RCLONE_REMOTE = process.env.RCLONE_REMOTE || ''; // 例: "gdrive:" 。設定時はクラウド(rclone)モード、未設定ならローカルfs
// 書き込み用リモート(未設定ならRCLONE_REMOTEと同じ)。SAは保存容量quotaを持てずマイドライブに書き込めないため、
// 書き込みだけユーザーOAuthのリモート(gdrivew:)を使う
const RCLONE_WRITE = process.env.RCLONE_WRITE_REMOTE || RCLONE_REMOTE;
const RCLONE_CONF = process.env.RCLONE_CONF || '';     // rclone.conf のパス(任意)
function rcloneArgs(extra) { const a = extra.slice(); if (RCLONE_CONF) a.push('--config', RCLONE_CONF); return a; }
const CACHE = path.join(__dirname, 'sites.json'); // 現場一覧キャッシュ
const SAVES = path.join(__dirname, 'saves');      // 現場ごとの作図データ保存先
const RESCAN_MS = 24 * 60 * 60 * 1000;            // 起動時の再スキャン判定(24h)。定期実行は毎日JST0時(下部)
try { fs.mkdirSync(SAVES); } catch { }
function savePath(key) { return path.join(SAVES, crypto.createHash('sha1').update(String(key)).digest('hex') + '.json'); }

// ===== PDFキャッシュ(VMディスク) =====
// 配置図PDFをDriveから取り出す代わりにディスクから返して高速化。md5(scanで取得)で変更検知。
const PDFCACHE = path.join(__dirname, 'pdfcache');
try { fs.mkdirSync(PDFCACHE); } catch { }
const PDF_MANIFEST = path.join(PDFCACHE, 'manifest.json');
let pdfManifest = {};                              // pid -> キャッシュ済みファイルのmd5
try { pdfManifest = JSON.parse(fs.readFileSync(PDF_MANIFEST, 'utf8')); } catch { }
function savePdfManifest() { try { fs.writeFileSync(PDF_MANIFEST, JSON.stringify(pdfManifest)); } catch { } }
function pdfCachePath(pid) { return path.join(PDFCACHE, pid + '.pdf'); }

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
  stairsPerStep: 10000,                                // 階段下地: 1段あたりの加算額(段数×これを現場合計に加算)
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
    stairsPerStep: num(s.stairsPerStep, D.stairsPerStep),
  };
}

// 階段下地の段数を保存図形(頂点+縮尺)から再計算。古い保存(stairsが面積㎡)も自動補正。
// app.js の minRectShortSide / stairsStepCount と同じロジック(短辺÷0.3を四捨五入)。
function minRectShortSide(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  let bestArea = Infinity, shortSide = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    let ux = b.x - a.x, uy = b.y - a.y; const L = Math.hypot(ux, uy); if (L < 1e-6) continue;
    ux /= L; uy /= L; const vx = -uy, vy = ux;
    let mU = Infinity, MU = -Infinity, mV = Infinity, MV = -Infinity;
    for (const p of pts) { const du = p.x * ux + p.y * uy, dv = p.x * vx + p.y * vy; if (du < mU) mU = du; if (du > MU) MU = du; if (dv < mV) mV = dv; if (dv > MV) MV = dv; }
    const w = MU - mU, h = MV - mV, area = w * h;
    if (area < bestArea) { bestArea = area; shortSide = Math.min(w, h); }
  }
  return shortSide;
}
function recomputeStairsSteps(rec) {
  const mPerPx = rec && rec.mPerPx; if (!mPerPx || !Array.isArray(rec.elements)) return null;
  let steps = 0;
  for (const el of rec.elements) if (el.cat === 'stairs') { const m = minRectShortSide(el.points) * mPerPx; if (m > 0) steps += Math.max(1, Math.round(m / 0.3)); }
  return steps;
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
// 現場内の配置図一覧(plans)を作る。スコア順に並べ、md5一致の重複だけ除去。
// 先頭(primary=最良スコア)の保存キーは現場キーのまま(既存の保存と互換)。他はキー#pid。
function buildPlans(raw, siteKey, srcField) {
  raw.sort((a, b) => b.score - a.score || String(a.to).localeCompare(String(b.to), 'ja'));
  const seen = new Set(), uniq = [];
  for (const pl of raw) { if (pl.md5 && seen.has(pl.md5)) continue; if (pl.md5) seen.add(pl.md5); uniq.push(pl); }
  return uniq.map((pl, j) => {
    const src = pl[srcField];
    const pid = crypto.createHash('sha1').update(String(src)).digest('hex').slice(0, 12);
    const plan = { pid, label: pl.to || pl.file, savekey: j === 0 ? siteKey : siteKey + '#' + pid, md5: pl.md5 || '' };
    plan[srcField] = src;   // path(クラウド) または file(ローカル)
    return plan;
  });
}
function scan() {
  if (RCLONE_REMOTE) {
    // クラウド(rclone): リモート配下の全ファイルを取得してグループ化
    let arr = [];
    try {
      arr = JSON.parse(execFileSync('rclone', rcloneArgs(['lsjson', RCLONE_REMOTE, '-R', '--files-only', '--hash']), { maxBuffer: 128 * 1024 * 1024 }).toString());
    } catch (e) { console.error('[scan] rclone lsjson 失敗:', e.message); }
    const bySite = {}, tos = {};
    for (const it of arr) {
      const p = it.Path;                                     // 例: 鶴岡/日付_現場名/1号棟/(原図)配置図_*.pdf
      if (!/配置図.*\.pdf$/i.test(p) || /見取|求積/.test(p)) continue;
      const seg = p.split('/'); if (seg.length < 3) continue;
      const file = seg[seg.length - 1], site = seg[seg.length - 3], to = seg[seg.length - 2];
      const region = seg.length >= 4 ? seg[seg.length - 4] : '';
      const key = seg.slice(0, seg.length - 2).join('/');     // 現場フォルダ(棟の1つ上)
      (tos[key] = tos[key] || new Set()).add(to);             // 棟フォルダを数える
      const md5 = (it.Hashes && (it.Hashes.md5 || it.Hashes.MD5)) || '';
      const score = (/原図/.test(file) ? 2 : 0) + (/1号棟|１号棟/.test(file) ? 1 : 0);
      (bySite[key] = bySite[key] || { region, site, key, raw: [] }).raw.push({ to, file, path: p, md5, score });
    }
    sites = Object.values(bySite)
      .map((g, i) => ({ id: String(i + 1), key: g.key, region: g.region, site: g.site, buildings: (tos[g.key] || new Set()).size || 1, plans: buildPlans(g.raw, g.key, 'path') }))
      .sort((a, b) => a.site.localeCompare(b.site, 'ja'));
  } else {
    // ローカルfs
    const hits = []; walk(BASE, hits);
    const bySite = {}, tos = {};
    for (const f of hits) {
      const siteDir = path.dirname(path.dirname(f));          // 棟の1つ上
      const region = path.basename(path.dirname(siteDir)), site = path.basename(siteDir);
      const to = path.basename(path.dirname(f));
      (tos[siteDir] = tos[siteDir] || new Set()).add(to);
      const score = (/原図/.test(f) ? 2 : 0) + (/1号棟|１号棟/.test(f) ? 1 : 0);
      (bySite[siteDir] = bySite[siteDir] || { region, site, key: siteDir, raw: [] }).raw.push({ to, file: f, score });
    }
    sites = Object.values(bySite)
      .map((g, i) => ({ id: String(i + 1), key: g.key, region: g.region, site: g.site, buildings: (tos[g.key] || new Set()).size || 1, plans: buildPlans(g.raw, g.key, 'file') }))
      .sort((a, b) => a.site.localeCompare(b.site, 'ja'));
  }
  fs.writeFileSync(CACHE, JSON.stringify({ scannedAt: new Date().toISOString(), v: 2, sites }, null, 2));
  console.log(`[scan] ${sites.length} 現場 (${new Date().toLocaleString('ja-JP')})`);
}
function loadCacheOrScan() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    sites = c.sites || [];
    // 旧形式キャッシュ(plans無し)や期限切れは再スキャン
    if (!sites.length || !sites[0].plans || Date.now() - new Date(c.scannedAt).getTime() > RESCAN_MS) scan();
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
  // 現在のログイン者が管理者か(ナビに管理者リンクを出すか判定するため)
  if (u.pathname === '/api/me') { res.writeHead(200, { 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify({ owner: isOwner(req) })); }
  // --- 管理者ページ(大元アカウントのみ) ---
  if (u.pathname === '/admin' || u.pathname === '/admin.html' || u.pathname === '/admin.js' || u.pathname === '/api/admin/allowlist') {
    if (!isOwner(req)) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>権限がありません</h2><p>このページは管理者(大元アカウント)専用です。</p><p><a href="/">戻る</a></p></body>'); }
    if (u.pathname === '/admin.js') return serveFile(res, path.join(__dirname, 'admin.js'));
    if (u.pathname === '/admin' || u.pathname === '/admin.html') return serveFile(res, path.join(__dirname, 'admin.html'));
    // /api/admin/allowlist
    if (req.method === 'POST') {
      let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(b);
          const add = normEmail(j.add), remove = normEmail(j.remove);
          if (add) { if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(add)) { res.writeHead(400, { 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify({ error: 'メール形式が正しくありません' })); } if (!ALLOWLIST.includes(add)) ALLOWLIST.push(add); }
          if (remove) { if (remove === OWNER) { res.writeHead(400, { 'Content-Type': MIME['.json'] }); return res.end(JSON.stringify({ error: '大元アカウントは削除できません' })); } ALLOWLIST = ALLOWLIST.filter(e => e !== remove); }
          saveAllowlist();
          res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify({ list: ALLOWLIST, owner: OWNER }));
        } catch { res.writeHead(400, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify({ error: 'リクエスト不正' })); }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ list: ALLOWLIST, owner: OWNER }));
  }
  if (u.pathname === '/api/sites') {
    // 配置図ごとの作成済判定: 保存があり描画要素が1つ以上
    const done = sk => { try { const r = JSON.parse(fs.readFileSync(savePath(sk), 'utf8')); return Array.isArray(r.elements) && r.elements.length > 0; } catch { return false; } };
    // クライアントには path/file は渡さない(pid/savekey/label/doneのみ)
    const out = sites.map(s => ({ id: s.id, key: s.key, region: s.region, site: s.site, buildings: s.buildings, plans: (s.plans || []).map(p => ({ pid: p.pid, label: p.label, savekey: p.savekey, done: done(p.savekey) })) }));
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ sites: out }));
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
  // 外構図PDFをDriveの現場フォルダ配下「外構図作成/」へ保存(クラウド=rclone rcat / ローカルfs=直接書き込み)
  // 前提: 書き込みリモート(RCLONE_WRITE_REMOTE)に「A1現場情報」への書き込み権限が必要
  if (u.pathname === '/api/export' && req.method === 'POST') {
    const key = String(u.query.key || '');
    let site = null, plan = null;                    // savekeyで現場と配置図を特定(=クライアント任意のパスを受けない)
    for (const s of sites) { for (const p of (s.plans || [])) if (p.savekey === key) { site = s; plan = p; break; } if (site) break; }
    if (!site) { res.writeHead(404); return res.end('no site'); }
    const chunks = []; let len = 0;
    req.on('data', c => { chunks.push(c); len += c.length; if (len > 60e6) req.destroy(); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 100) { res.writeHead(400); return res.end('empty'); }
      const ts = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', '_').replace(':', '');   // JSTタイムスタンプ(例 2026-07-03_1430)
      const name = `外構図_${site.site}_${site.buildings || 1}棟_${ts}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(obj)); };
      if (RCLONE_REMOTE) {
        const dest = site.key + '/外構図作成/' + name;
        const ps = spawn('rclone', rcloneArgs(['rcat', RCLONE_WRITE + dest]));
        let err = '', done = false;
        ps.stderr.on('data', c => err += c);
        ps.on('close', code => {
          if (done) return; done = true;
          if (code === 0) return json(200, { ok: true, path: dest });
          console.error('[export] rclone rcat 失敗:', err.trim().slice(-500));
          json(500, { error: 'Driveへの保存に失敗しました(サービスアカウントの書き込み権限を確認)' });
        });
        ps.on('error', () => { if (!done) { done = true; json(500, { error: 'rclone起動に失敗しました' }); } });
        ps.stdin.end(buf);
        return;
      }
      // ローカルfs: key=現場フォルダの絶対パス
      try {
        const dir = path.join(site.key, '外構図作成');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), buf);
        json(200, { ok: true, path: path.join(site.site, '外構図作成', name) });
      } catch (e) { json(500, { error: '保存に失敗しました: ' + e.message }); }
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
    // 現場ごとに、その現場の全配置図(plans)の数量を合計して1現場ぶんにする
    const out = sites.map(s => {
      const q = { hasScale: false, asphalt: 0, garden: 0, gravel: 0, stairs: 0, curb: 0, dan1: 0, dan2: 0, dan3: 0, dan4: 0, dan5: 0, post: 0, faucet: 0, camera: 0 };
      let any = false, savedAt = null;
      for (const p of (s.plans || [])) {
        try {
          const rec = JSON.parse(fs.readFileSync(savePath(p.savekey), 'utf8'));
          if (!rec.quantities) continue;
          any = true;
          const pq = rec.quantities;
          if (pq.hasScale) q.hasScale = true;
          const stSteps = recomputeStairsSteps(rec);   // 階段は図形から段数を再計算(古い保存も補正)
          q.asphalt += pq.asphalt || 0; q.garden += pq.garden || 0; q.gravel += pq.gravel || 0;
          q.curb += pq.curb || 0; q.dan1 += pq.dan1 || 0; q.dan2 += pq.dan2 || 0; q.dan3 += pq.dan3 || 0; q.dan4 += pq.dan4 || 0; q.dan5 += pq.dan5 || 0;
          q.post += pq.post || 0; q.faucet += pq.faucet || 0; q.camera += pq.camera || 0;
          q.stairs += (stSteps != null ? stSteps : (pq.stairs || 0));
          if (rec.savedAt && (!savedAt || rec.savedAt > savedAt)) savedAt = rec.savedAt;
        } catch { }
      }
      return { id: s.id, site: s.site, region: s.region, key: s.key, buildings: s.buildings || 1, quantities: any ? q : null, savedAt };
    });
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ sites: out, settings: loadCostSettings() }));
  }
  if (u.pathname === '/api/pdf') {
    let target = null;                       // pidで配置図(plan)を特定
    for (const s of sites) { for (const p of (s.plans || [])) if (p.pid === u.query.pid) { target = p; break; } if (target) break; }
    if (!target) { res.writeHead(404); return res.end('no plan'); }
    if (RCLONE_REMOTE && target.path) {      // クラウド: キャッシュ優先、変更(md5不一致)時のみrcloneで取り直す
      const cf = pdfCachePath(target.pid), md5 = target.md5 || '';
      if (md5 && pdfManifest[target.pid] === md5 && fs.existsSync(cf)) {   // キャッシュヒット=即返す
        res.writeHead(200, { 'Content-Type': MIME['.pdf'] });
        return fs.createReadStream(cf).pipe(res);
      }
      // キャッシュミス/変更あり: ストリームしながら集めてキャッシュに保存(イベントループは塞がない)
      res.writeHead(200, { 'Content-Type': MIME['.pdf'] });
      const ps = spawn('rclone', rcloneArgs(['cat', RCLONE_REMOTE + target.path]));
      const chunks = [];
      ps.stdout.on('data', c => chunks.push(c));
      ps.stdout.pipe(res);
      ps.on('close', code => { if (code === 0) { try { fs.writeFileSync(cf, Buffer.concat(chunks)); pdfManifest[target.pid] = md5; savePdfManifest(); } catch { } } });
      ps.on('error', () => { try { res.destroy(); } catch { } });
      return;
    }
    return serveFile(res, target.file);
  }
  res.writeHead(404); res.end('not found');
});

// 毎日 JST 0:00 に再スキャン(JST=UTC+9 なので UTC 15:00)。実行後に孤立PDFキャッシュを掃除。
function msUntilNextJstMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(15, 0, 0, 0);           // UTC15:00 = JST翌0:00
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}
function cleanPdfCache() {                  // 現存しない配置図(削除された現場等)のキャッシュを削除
  try {
    const valid = new Set();
    for (const s of sites) for (const p of (s.plans || [])) valid.add(p.pid + '.pdf');
    for (const f of fs.readdirSync(PDFCACHE)) {
      if (f === 'manifest.json' || valid.has(f)) continue;
      try { fs.unlinkSync(path.join(PDFCACHE, f)); } catch { }
      delete pdfManifest[f.replace(/\.pdf$/, '')];
    }
    savePdfManifest();
  } catch { }
}
// 配置図PDFを1つキャッシュに取り込む(spawn=非同期。イベントループを塞がない)
function fetchToCache(p) {
  return new Promise(resolve => {
    const ps = spawn('rclone', rcloneArgs(['cat', RCLONE_REMOTE + p.path]));
    const chunks = [];
    ps.stdout.on('data', c => chunks.push(c));
    ps.on('close', code => {
      if (code === 0) { try { fs.writeFileSync(pdfCachePath(p.pid), Buffer.concat(chunks)); pdfManifest[p.pid] = p.md5 || ''; savePdfManifest(); } catch { } }
      resolve();
    });
    ps.on('error', () => resolve());
  });
}
// 未キャッシュ/変更ありの配置図を裏で先読み(逐次)。初回オープンの遅さを無くす。
let _warming = false;
async function warmPdfCache() {
  if (!RCLONE_REMOTE || _warming) return;
  const queue = [];
  for (const s of sites) for (const p of (s.plans || [])) {
    if (!p.path) continue;
    if (p.md5 && pdfManifest[p.pid] === p.md5 && fs.existsSync(pdfCachePath(p.pid))) continue;  // 既に最新
    queue.push(p);
  }
  if (!queue.length) return;
  _warming = true;
  console.log(`[warm] ${queue.length}件のPDFを先読み開始`);
  for (const p of queue) await fetchToCache(p);   // 1つずつ(同時多数のrcloneを避ける)
  _warming = false;
  console.log('[warm] 先読み完了');
}
function scheduleDailyScan() {
  setTimeout(() => {
    try { scan(); cleanPdfCache(); warmPdfCache(); console.log('[daily] 再スキャン完了 (' + new Date().toLocaleString('ja-JP') + ')'); }
    catch (e) { console.error('[daily] 失敗', e.message); }
    scheduleDailyScan();                   // 次のJST0時を再計算(ドリフト防止)
  }, msUntilNextJstMidnight());
}

loadCacheOrScan();
scheduleDailyScan();
setTimeout(warmPdfCache, 3000);            // 起動3秒後に先読み(デプロイ後すぐ埋める)
server.listen(PORT, () => console.log(`外構図作成: http://localhost:${PORT}  (現場 ${sites.length}件 / 認証 ${AUTH_ENABLED ? 'ON' : 'OFF'})`));
