/* 費用管理 — 係数制度で各現場の費用を算出して一覧表示
 * 数量(現場合計)は拾いツールの保存に含まれる quantities を使用。
 * 棟数はサーバが棟フォルダ数から自動算出。設定(係数等)はサーバ保存。
 * 計算ロジックは姉妹プロジェクト「費用算出」の仕様に準拠。
 */
'use strict';

const DEFAULTS = {
  fixed: 10000, base: 440000,
  std: { asphalt: 60, garden: 25, blockPt: 25.5 },
  alloc: { asphalt: 0.60, block: 0.25, garden: 0.15 },
  coefBase: 1, coefTsumi: 1,
  adj: { asphalt: 1, block: 1, garden: 1 },
  gravelRatio: 0.5,
};
const ST = { sites: [], settings: null };

// ===== 係数計算(1現場ぶん) =====
function computeCost(q, buildings, st) {
  const b = Math.max(1, buildings || 1);
  const pt = { curb: st.coefBase * 1.5, d1: st.coefBase + st.coefTsumi, d2: st.coefBase + st.coefTsumi * 2, d3: st.coefBase + st.coefTsumi * 3, d4: st.coefBase + st.coefTsumi * 4, d5: st.coefBase + st.coefTsumi * 5 };
  const blockPtTotal = (q.curb || 0) * pt.curb + (q.dan1 || 0) * pt.d1 + (q.dan2 || 0) * pt.d2 + (q.dan3 || 0) * pt.d3 + (q.dan4 || 0) * pt.d4 + (q.dan5 || 0) * pt.d5;
  const div = (a, d) => d > 0 ? a / d : 0;
  const coef = (ratio, adj) => 1 + (ratio - 1) * adj;
  // 砕石はアスファルト換算(×gravelRatio)でアス係数に算入
  const asphaltEq = (q.asphalt || 0) + (q.gravel || 0) * (st.gravelRatio ?? 0.5);
  const cA = coef(div(div(asphaltEq, b), st.std.asphalt), st.adj.asphalt);
  const cG = coef(div(div(q.garden || 0, b), st.std.garden), st.adj.garden);
  const cB = coef(div(div(blockPtTotal, b), st.std.blockPt), st.adj.block);
  const finalCoef = cA * st.alloc.asphalt + cB * st.alloc.block + cG * st.alloc.garden;
  const perBuilding = st.fixed + st.base * finalCoef;
  return { blockPtTotal, cA, cG, cB, finalCoef, perBuilding, total: perBuilding * b };
}

// ===== ユーティリティ =====
const yen = v => '¥' + Math.round(v).toLocaleString('ja-JP');
const n2 = v => (v || 0).toFixed(2);
const n3 = v => (v || 0).toFixed(3);

// ===== 設定フォーム =====
const SET_FIELDS = {
  s_fixed: ['fixed'], s_base: ['base'],
  s_std_asphalt: ['std', 'asphalt'], s_std_garden: ['std', 'garden'], s_std_blockPt: ['std', 'blockPt'],
  s_alloc_asphalt: ['alloc', 'asphalt'], s_alloc_block: ['alloc', 'block'], s_alloc_garden: ['alloc', 'garden'],
  s_coefBase: ['coefBase'], s_coefTsumi: ['coefTsumi'],
  s_adj_asphalt: ['adj', 'asphalt'], s_adj_block: ['adj', 'block'], s_adj_garden: ['adj', 'garden'],
  s_gravelRatio: ['gravelRatio'],
};
function fillSettings(st) {
  for (const id in SET_FIELDS) { const p = SET_FIELDS[id]; const v = p.length === 1 ? st[p[0]] : st[p[0]][p[1]]; document.getElementById(id).value = v; }
  checkAlloc();
}
function readSettings() {
  const st = JSON.parse(JSON.stringify(DEFAULTS));
  for (const id in SET_FIELDS) {
    const p = SET_FIELDS[id], v = parseFloat(document.getElementById(id).value);
    const val = isFinite(v) ? v : (p.length === 1 ? DEFAULTS[p[0]] : DEFAULTS[p[0]][p[1]]);
    if (p.length === 1) st[p[0]] = val; else st[p[0]][p[1]] = val;
  }
  return st;
}
function checkAlloc() {
  const st = readSettings(), sum = st.alloc.asphalt + st.alloc.block + st.alloc.garden;
  const el = document.getElementById('allocCheck');
  if (Math.abs(sum - 1) < 1e-6) { el.className = 'ok'; el.textContent = '配分合計 1.00 ✓'; }
  else { el.className = 'warn'; el.textContent = `配分合計 ${sum.toFixed(2)}（1.00 推奨）`; }
}

// ===== 表の描画 =====
// 列定義: cls=site/bldg は左固定、detail=true は「詳細列」トグルで表示切替、f=値の取り出し
const COLS = [
  { h: '現場', cls: 'site' },
  { h: '棟数', cls: 'bldg' },
  { h: 'アス㎡', f: q => n2(q.asphalt) },
  { h: '庭㎡', f: q => n2(q.garden) },
  { h: '砕石㎡', f: q => n2(q.gravel), detail: true },
  { h: '階段㎡', f: q => n2(q.stairs), detail: true },
  { h: '地先m', f: q => n2(q.curb) },
  { h: '1段', f: q => n2(q.dan1), detail: true },
  { h: '2段', f: q => n2(q.dan2), detail: true },
  { h: '3段', f: q => n2(q.dan3), detail: true },
  { h: '4段', f: q => n2(q.dan4), detail: true },
  { h: '5段', f: q => n2(q.dan5), detail: true },
  { h: 'Bpt', f: (q, r) => n2(r.blockPtTotal) },
  { h: 'アス係数', f: (q, r) => n3(r.cA), detail: true },
  { h: 'ﾌﾞﾛｯｸ係数', f: (q, r) => n3(r.cB), detail: true },
  { h: '庭係数', f: (q, r) => n3(r.cG), detail: true },
  { h: '最終係数', f: (q, r) => n3(r.finalCoef) },
  { h: '1棟金額', f: (q, r) => yen(r.perBuilding), cls: 'money' },
  { h: '現場合計', f: (q, r) => yen(r.total), cls: 'money' },
];
function newCell(col, tag) {
  const el = document.createElement(tag || 'td');
  if (col.cls) el.className = col.cls;
  if (col.detail) el.classList.add('detail');
  return el;
}
function render() {
  const st = readSettings();
  const body = document.getElementById('costBody');
  body.innerHTML = '';
  // ヘッダ
  const thead = document.createElement('tr');
  COLS.forEach(col => { const th = newCell(col, 'th'); th.textContent = col.h; thead.appendChild(th); });
  body.appendChild(thead);

  let grand = 0, drawn = 0;
  ST.sites.forEach(s => {
    const q = s.quantities;
    const tr = document.createElement('tr');
    if (q && q.hasScale) {
      drawn++;
      const r = computeCost(q, s.buildings, st); grand += r.total;
      COLS.forEach(col => {
        const td = newCell(col);
        if (col.cls === 'site') { td.textContent = s.site; td.title = s.site; }
        else if (col.cls === 'bldg') td.textContent = s.buildings;
        else td.textContent = col.f(q, r);
        tr.appendChild(td);
      });
    } else {
      const note = !q ? '未拾い' : '縮尺未設定';
      const tdS = newCell(COLS[0]); tdS.textContent = s.site; tdS.title = s.site; tr.appendChild(tdS);
      const tdB = newCell(COLS[1]); tdB.textContent = s.buildings; tr.appendChild(tdB);
      const tdN = document.createElement('td'); tdN.colSpan = COLS.length - 2; tdN.style.textAlign = 'left'; tdN.innerHTML = `<span class="pill">${note}</span>`; tr.appendChild(tdN);
    }
    body.appendChild(tr);
  });

  // 総合計行
  const gtr = document.createElement('tr'); gtr.className = 'grand';
  COLS.forEach(col => {
    const td = newCell(col);
    if (col.cls === 'site') td.textContent = '総合計';
    else if (col.h === '現場合計') td.textContent = yen(grand);
    gtr.appendChild(td);
  });
  body.appendChild(gtr);

  // 棟数列の左固定位置を、現場名列の実幅(内容に合わせた幅)に合わせる
  const siteTh = document.querySelector('#costBody th.site');
  if (siteTh) { const w = siteTh.offsetWidth; document.querySelectorAll('#costBody .bldg').forEach(el => { el.style.left = w + 'px'; }); }

  document.getElementById('grandTotal').textContent = yen(grand);
  document.getElementById('countInfo').textContent = `拾い済 ${drawn} / 全 ${ST.sites.length} 現場`;
  document.getElementById('emptyNote').textContent = drawn < ST.sites.length
    ? '「未拾い」＝まだ作図保存がない現場。「縮尺未設定」＝外構図作成で縮尺(1/100・1/150)を選んで保存し直すと金額が出ます。' : '';
}

// ===== 読み込み =====
async function load() {
  try {
    const r = await fetch('/api/costsites'); const j = await r.json();
    ST.sites = j.sites || []; ST.settings = j.settings || DEFAULTS;
    fillSettings(ST.settings);
    render();
  } catch (e) {
    document.getElementById('emptyNote').textContent = 'データを取得できませんでした。サーバーを確認してください。';
  }
}

function init() {
  document.getElementById('btnToggleSet').addEventListener('click', () => {
    const p = document.getElementById('setPanel'); p.style.display = p.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('btnReload').addEventListener('click', load);
  document.getElementById('btnResetSet').addEventListener('click', () => { fillSettings(DEFAULTS); render(); });
  document.querySelectorAll('.setgrid input').forEach(i => i.addEventListener('input', () => { checkAlloc(); render(); }));
  document.getElementById('btnSaveSet').addEventListener('click', async () => {
    const st = readSettings();
    const msg = document.getElementById('setMsg');
    try { await fetch('/api/costsettings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st) }); msg.className = 'ok'; msg.textContent = '保存しました'; }
    catch { msg.className = 'warn'; msg.textContent = '保存失敗'; }
    setTimeout(() => { msg.textContent = ''; }, 2500);
  });
  load();
}
init();
