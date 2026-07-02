/* 外構積算 拾いツール — メインロジック
 * 配置図(PDF)を背景に、ブロック(線)/アスファルト等(範囲)/スタンプ(点)を描き、
 * 引いた線長・囲んだ面積・スタンプ個数を実寸で即時集計する。座標は全て「画像座標」
 * (描画したPDFの素のピクセル系)で保持し、ズーム/パンはステージ変換で行う。
 */
'use strict';

// ===== カテゴリ定義(凡例・色・単位) =====
const CATS = {
  block_normal: { label: '普通ブロック', color: '#e11d48', kind: 'line', unit: 'm', dan: true },
  block_curb:   { label: '地先ブロック', color: '#1d4ed8', kind: 'line', unit: 'm', dan: false },
  asphalt: { label: 'アスファルト', color: '#0d9488', kind: 'area', unit: '㎡', style: 'hatch' },
  garden:  { label: '庭・土',      color: '#ea7a17', kind: 'area', unit: '㎡', style: 'cross' },
  gravel:  { label: '砕石',        color: '#64748b', kind: 'area', unit: '㎡', style: 'hatch' },
  stairs:  { label: '階段下地',    color: '#7c3aed', kind: 'area', unit: '段', style: 'fill' },
  post:    { label: 'ポスト',      color: '#db2777', kind: 'stamp', unit: '個', mark: 'P' },
  faucet:  { label: '散水栓',      color: '#0891b2', kind: 'stamp', unit: '個', mark: 'S' },
  camera:  { label: '防犯カメラ',  color: '#ea580c', kind: 'stamp', unit: '個', mark: 'C' },
};

// ===== 状態 =====
const S = {
  stage: null, bgLayer: null, shapeLayer: null, previewLayer: null,
  imgW: 0, imgH: 0,
  mPerPx: null,          // 1画像pxあたりの実寸(m)。null=未設定
  scaleDenom: null,      // 縮尺の分母(100/150)。表示用
  elements: [],          // {id,cat,points:[{x,y}],type?,dan?,node}
  tool: 'select',
  draft: null,           // 作図中の点配列
  selected: null,
  calib: null,           // 縮尺キャリブレーション中の状態
  idSeq: 1,
};

const SNAP_PX = 12;      // スナップ判定(スクリーンpx)
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ===== 初期化 =====
function init() {
  const wrap = document.getElementById('stageWrap');
  S.stage = new Konva.Stage({ container: 'stage', width: wrap.clientWidth, height: wrap.clientHeight });
  S.bgLayer = new Konva.Layer(); S.shapeLayer = new Konva.Layer(); S.previewLayer = new Konva.Layer();
  S.stage.add(S.bgLayer); S.stage.add(S.shapeLayer); S.stage.add(S.previewLayer);

  window.addEventListener('resize', () => {
    S.stage.width(wrap.clientWidth); S.stage.height(wrap.clientHeight);
  });

  setupZoomPan();
  setupStageEvents();
  setupUI();
  renderLegend();
  setTool('select');
  loadSites();
}

// 縮尺基準の線幅(画像px)。ブロックは実幅、範囲は縁線。mPerPx未設定時は固定px。
function lineW(kind) {
  if (!S.mPerPx) return kind === 'line' ? 4 : 2;
  const realm = kind === 'line' ? 0.12 : 0.05;
  return Math.max(realm / S.mPerPx, 1);
}
function stampRadius() { return S.mPerPx ? Math.max(0.2625 / S.mPerPx, 6) : 12; }
function restyleStrokes() { for (const el of S.elements) rebuildElement(el); keepStampSizes(); applyZOrder(); }  // 再生成後は重なり順を必ず再適用

// ===== ツール選択 =====
function setTool(t) {
  S.tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.getElementById('blockOpts').style.display = (t === 'block_normal') ? 'flex' : 'none';
  cancelDraft();
  // 選択ツール以外では既存図形のドラッグを止める
  const sel = (t === 'select');
  S.shapeLayer.getChildren().forEach(n => n.draggable(sel));
  S.elements.forEach(el => { if (el._label) el._label.draggable(sel); }); // 段数ラベルも追従
  S.stage.container().style.cursor = (t === 'pan') ? 'grab' : (t === 'select' ? 'default' : 'crosshair');
}

function setupUI() {
  document.querySelectorAll('.tool').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));
  document.getElementById('scaleSelect').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (v) setScale(v);
    else { S.mPerPx = null; S.scaleDenom = null; updateScaleInfo('未設定'); markScaleButtons(); restyleStrokes(); recalc(); }
  });
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnRedo').addEventListener('click', redo);
  document.getElementById('btnClear').addEventListener('click', clearAllDrawings);
  document.getElementById('btnFit').addEventListener('click', fitView);
  document.getElementById('btnExport').addEventListener('click', exportPDF);
  document.getElementById('btnSave').addEventListener('click', () => saveState(true));
  document.getElementById('btnBack').addEventListener('click', showPicker);
  document.getElementById('planSwitch').addEventListener('change', switchPlan);
  // 現場選択画面
  document.getElementById('siteSearch').addEventListener('input', filterSites);
  document.getElementById('btnRescan').addEventListener('click', rescanSites);
  document.getElementById('pdfInputManual').addEventListener('change', onPdfChosen);
  document.addEventListener('keydown', onKey);
}

// ===== 現場選択 =====
let ALL_SITES = [];
async function loadSites() {
  const box = document.getElementById('siteList');
  try {
    const r = await fetch('/api/sites'); const j = await r.json();
    ALL_SITES = j.sites || [];
    renderSites(ALL_SITES);
  } catch (e) {
    box.innerHTML = 'サーバーに接続できません。<br><code>node server.js</code> を起動し、<b>http://localhost:5050</b> で開いてください。<br>（または下の「PDFを手動で開く」）';
  }
}
function renderSites(list) {
  const box = document.getElementById('siteList');
  if (!list.length) { box.textContent = '配置図が見つかりません'; return; }
  box.innerHTML = '';
  list.forEach(s => {
    const plans = s.plans || [];
    const doneCount = plans.filter(p => p.done).length;
    const d = document.createElement('div'); d.className = 'siteitem';
    const nm = document.createElement('span'); nm.textContent = s.site; d.appendChild(nm);
    const reg = document.createElement('span'); reg.className = 'reg';
    // 外構図 作成済/未 バッジ
    const badge = document.createElement('span');
    if (plans.length > 1) {
      badge.className = 'donebadge ' + (doneCount === plans.length ? 'done' : doneCount ? 'partial' : 'undone');
      badge.textContent = `${doneCount}/${plans.length}作成`;
    } else {
      const dn = plans[0] && plans[0].done;
      badge.className = 'donebadge ' + (dn ? 'done' : 'undone');
      badge.textContent = dn ? '✓作成済' : '未作成';
    }
    reg.appendChild(badge);
    reg.appendChild(document.createTextNode(s.region + (plans.length > 1 ? '  ' : '')));
    if (plans.length > 1) {                       // 他号棟の配置図を選ぶトグル(行クリックはprimaryを開く)
      const exp = document.createElement('span'); exp.className = 'planexp'; exp.textContent = `配置図${plans.length}枚 ▾`;
      exp.title = '別の号棟の配置図を選ぶ';
      exp.onclick = (e) => { e.stopPropagation(); togglePlans(s, d); };
      reg.appendChild(exp);
    }
    d.appendChild(reg);
    d.onclick = () => openPlan(s, plans[0]);       // 既定: primary(1号棟/原図)を即開く
    box.appendChild(d);
  });
}
// 複数配置図の現場: 行をクリックで配置図一覧を開閉
function togglePlans(s, rowEl) {
  const next = rowEl.nextElementSibling;
  if (next && next.classList.contains('planlist')) { next.remove(); return; }
  document.querySelectorAll('.planlist').forEach(e => e.remove());
  const pl = document.createElement('div'); pl.className = 'planlist';
  (s.plans || []).forEach(p => {
    const b = document.createElement('div'); b.className = 'planitem';
    const t = document.createElement('span'); t.textContent = '▸ ' + p.label; b.appendChild(t);
    const st = document.createElement('span'); st.className = p.done ? 'pdone' : 'pundone'; st.textContent = p.done ? '✓作成済' : '未作成'; b.appendChild(st);
    b.onclick = (e) => { e.stopPropagation(); openPlan(s, p); };
    pl.appendChild(b);
  });
  rowEl.after(pl);
}
function filterSites() {
  const q = document.getElementById('siteSearch').value.trim();
  renderSites(q ? ALL_SITES.filter(s => (s.site + s.region).includes(q)) : ALL_SITES);
}
async function rescanSites() { document.getElementById('siteList').textContent = 'スキャン中…'; await fetch('/api/rescan'); loadSites(); }
function showLoading(t) { const el = document.getElementById('loadingTip'); if (el) { el.querySelector('.ltext').textContent = t || '外構図を読み込み中…'; el.style.display = 'flex'; } }
function hideLoading() { const el = document.getElementById('loadingTip'); if (el) el.style.display = 'none'; }
async function openPlan(s, p) {
  if (!p) return;
  S.currentSite = s;                              // 現在の現場(plans含む)を保持=作成画面から配置図を切替できる
  S.siteKey = p.savekey || s.key;                 // 保存キーは配置図ごと(primaryは現場キーで既存保存と互換)
  document.getElementById('siteName').textContent = s.site + (p.label ? ' — ' + p.label : '');
  showLoading(s.site + (p.label ? ' — ' + p.label : '') + ' を読み込み中…');   // クリック直後に即表示(PDF取得に数秒かかるため)
  try {
    const buf = await (await fetch('/api/pdf?pid=' + encodeURIComponent(p.pid))).arrayBuffer();
    hidePicker();
    await loadPdfBuffer(buf);
    await loadSaved();
    updatePlanSwitcher();                         // 同じ現場の配置図切替セレクトを更新
  } catch (e) {
    alert('配置図の読み込みに失敗しました。通信状況を確認して、もう一度お試しください。');
  } finally {
    hideLoading();
  }
}
// 同じ現場の配置図を切り替えるセレクト。現場が複数配置図のときだけ表示。
function updatePlanSwitcher() {
  const sel = document.getElementById('planSwitch'); if (!sel) return;
  const plans = (S.currentSite && S.currentSite.plans) || [];
  if (plans.length <= 1) { sel.style.display = 'none'; sel.innerHTML = ''; return; }
  sel.innerHTML = '';
  plans.forEach(p => { const o = document.createElement('option'); o.value = p.pid; o.textContent = '配置図: ' + p.label; sel.appendChild(o); });
  const cur = plans.find(p => p.savekey === S.siteKey);
  if (cur) sel.value = cur.pid;
  sel.style.display = '';
}
async function switchPlan() {
  const sel = document.getElementById('planSwitch');
  const s = S.currentSite; if (!s) return;
  const p = (s.plans || []).find(x => x.pid === sel.value);
  if (!p || p.savekey === S.siteKey) return;
  clearTimeout(_saveTimer); await saveState(true);  // 現在の作図を保存してから切替(消えないように)
  await openPlan(s, p);
}

// ===== 保存 / 読み込み(現場ごと) =====
function serializeState() {
  return {
    v: 1, mPerPx: S.mPerPx, scaleDenom: S.scaleDenom, idSeq: S.idSeq,
    elements: S.elements.map(e => ({ id: e.id, cat: e.cat, points: e.points, dan: e.dan, orient: e.orient, fontScale: e.fontScale, labelPos: e.labelPos })),
  };
}
// 費用算出(係数制度)用の数量サマリ。aggregate()の結果を現場合計の実寸でまとめる。
function costQuantities() {
  const agg = aggregate();
  const dan = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  Object.entries(agg.block_normal.sub || {}).forEach(([k, v]) => { const n = parseInt(k, 10); if (dan[n] != null) dan[n] += v; });
  return {
    hasScale: !!S.mPerPx,
    asphalt: agg.asphalt.qty, garden: agg.garden.qty, gravel: agg.gravel.qty, stairs: agg.stairs.qty,
    curb: agg.block_curb.qty, dan1: dan[1], dan2: dan[2], dan3: dan[3], dan4: dan[4], dan5: dan[5],
    post: agg.post.qty, faucet: agg.faucet.qty, camera: agg.camera.qty,
  };
}
async function saveState(manual) {
  if (!S.siteKey) return;
  try {
    await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: S.siteKey, data: serializeState(), quantities: costQuantities() }) });
    const t = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('saveInfo').textContent = (manual ? '保存しました ' : '自動保存 ') + t;
  } catch { document.getElementById('saveInfo').textContent = '保存失敗'; }
}
let _saveTimer;
function scheduleSave() { if (!S._loaded) return; clearTimeout(_saveTimer); _saveTimer = setTimeout(() => saveState(false), 800); }
function clearAllDrawings() {
  if (!S.elements.length) return;
  if (!confirm('描いたもの(凡例含む)をすべて削除しますか?')) return;
  clearElements(); recalc();   // 履歴に残るので「元に戻す」で復元可
}
function clearElements() {
  for (const el of S.elements) if (el.node) el.node.destroy();
  S.elements = []; S.selected = null;
  const si = document.getElementById('selInfo'); if (si) si.textContent = 'なし';
  S.previewLayer.destroyChildren(); S.previewLayer.batchDraw(); S.shapeLayer.batchDraw();
}
async function loadSaved() {
  S._loaded = false;
  clearElements();                               // 前の現場の内容を必ず破棄(クリアな状態から)
  try { const j = await (await fetch('/api/load?key=' + encodeURIComponent(S.siteKey))).json(); if (j && j.elements) loadStateData(j); }
  catch {}
  recalc(); restyleStrokes();
  S._loaded = true;
  S.hist = [JSON.stringify(serializeState())]; S.hi = 0; updateUndoRedoButtons(); // 履歴をこの現場で初期化
  document.getElementById('saveInfo').textContent = '';
}
function loadStateData(j) {
  clearElements();
  if (typeof j.idSeq === 'number') S.idSeq = j.idSeq;
  if (j.mPerPx) { S.mPerPx = j.mPerPx; S.scaleDenom = j.scaleDenom || null; updateScaleInfo((j.scaleDenom ? '1/' + j.scaleDenom : '手動')); markScaleButtons(); }
  for (const e of (j.elements || [])) { const el = Object.assign({}, e); delete el.node; S.elements.push(el); renderElement(el); }
  recalc(); restyleStrokes();
}
function showPicker() { document.getElementById('picker').style.display = 'flex'; document.getElementById('app').style.display = 'none'; loadSites(); }
function hidePicker() { document.getElementById('picker').style.display = 'none'; document.getElementById('app').style.display = 'flex'; S.stage.width(document.getElementById('stageWrap').clientWidth); S.stage.height(document.getElementById('stageWrap').clientHeight); }

function onKey(e) {
  if (e.key === 'Shift') S._shift = true;
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const map = { v:'select', b:'block_normal', j:'block_curb', a:'asphalt', g:'garden', k:'gravel', t:'stairs' };
  if (e.key === 'Escape') { cancelDraft(); clearCalib(); }
  else if (e.key === 'Enter') finishDraft();
  else if (e.key === 'Backspace') { if (S.draft && S.draft.length) { S.draft.pop(); drawPreview(lastPointer); } e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.shiftKey ? redo() : undo(); e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { redo(); e.preventDefault(); }
  else if (e.key === 'Delete') deleteSelected();
  else if (e.key === ' ') { S._spacePan = true; S.stage.container().style.cursor = 'grab'; }
  else if (map[e.key.toLowerCase()] && !S.draft) setTool(map[e.key.toLowerCase()]);
}
document.addEventListener('keyup', e => { if (e.key === 'Shift') S._shift = false; if (e.key === ' ') { S._spacePan = false; if (S.tool !== 'pan') S.stage.container().style.cursor = (S.tool === 'select' ? 'default' : 'crosshair'); } });

// ===== PDF読み込み =====
async function onPdfChosen(e) {
  const file = e.target.files[0]; if (!file) return;
  S.siteKey = null;                       // 手動PDFは保存対象外
  S.currentSite = null; updatePlanSwitcher();   // 配置図切替は非表示
  const buf = await file.arrayBuffer();
  document.getElementById('siteName').textContent = file.name;
  hidePicker();
  await loadPdfBuffer(buf);
  clearElements(); recalc();
  S._loaded = true; S.hist = [JSON.stringify(serializeState())]; S.hi = 0; updateUndoRedoButtons();
}

async function loadPdfBuffer(buf) {
  S._loaded = false;   // 読込中は自動保存/履歴記録を止める
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  // 縮尺と本体ページを判定: 「配置図」と「1/100」等を含むページを優先(なければ最終ページ)
  let target = 1, denom = null;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const txt = tc.items.map(t => t.str).join('').replace(/\s/g, '');
    const m = txt.match(/1\/(\d{2,3})/);
    if (txt.includes('配置図') && m) { target = i; denom = parseInt(m[1], 10); }
  }
  await renderPage(pdf, target, denom);
}

async function renderPage(pdf, pageNo, denom) {
  const page = await pdf.getPage(pageNo);
  const RS = 2.5;                                  // 1pt -> 2.5px でレンダ
  const viewport = page.getViewport({ scale: RS });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  S.imgW = canvas.width; S.imgH = canvas.height;
  S.bgLayer.destroyChildren();
  S.bgLayer.add(new Konva.Image({ image: canvas, x: 0, y: 0, width: S.imgW, height: S.imgH }));
  S.bgLayer.draw();
  document.getElementById('empty').style.display = 'none';

  // 縮尺: 理論値(A3ベクター前提)。m/pt = 0.000352778*denom, m/px = それ/RS
  if (denom) {
    S.scaleDenom = denom;
    S.mPerPx = 0.000352778 * denom / RS;
    updateScaleInfo('自動(1/' + denom + ')');
  } else {
    S.mPerPx = null; S.scaleDenom = null;
    updateScaleInfo('未設定 — 1/100か1/150を選択');
  }
  markScaleButtons();
  fitView();
  recalc();
  restyleStrokes();
}

function updateScaleInfo(src) {
  const el = document.getElementById('scaleInfo');
  if (S.mPerPx) el.textContent = `縮尺: ${src}  (${(1 / S.mPerPx).toFixed(1)} px/m)`;
  else el.textContent = '縮尺: ' + src;
}

// ===== ズーム / パン / フィット =====
function setupZoomPan() {
  S.stage.on('wheel', e => {
    e.evt.preventDefault();
    const old = S.stage.scaleX();
    const pointer = S.stage.getPointerPosition();
    const to = { x: (pointer.x - S.stage.x()) / old, y: (pointer.y - S.stage.y()) / old };
    const dir = e.evt.deltaY > 0 ? 1 / 1.1 : 1.1;
    const ns = Math.max(0.05, Math.min(20, old * dir));
    S.stage.scale({ x: ns, y: ns });
    S.stage.position({ x: pointer.x - to.x * ns, y: pointer.y - to.y * ns });
    keepStampSizes();
    S.stage.batchDraw();
  });
}

function fitView() {
  if (!S.imgW) return;
  const pad = 20;
  const sx = (S.stage.width() - pad * 2) / S.imgW, sy = (S.stage.height() - pad * 2) / S.imgH;
  const s = Math.min(sx, sy);
  S.stage.scale({ x: s, y: s });
  S.stage.position({ x: (S.stage.width() - S.imgW * s) / 2, y: (S.stage.height() - S.imgH * s) / 2 });
  keepStampSizes();
  S.stage.batchDraw();
}

// ===== ポインタ→画像座標 =====
let lastPointer = null;
function imgPos() { return S.stage.getRelativePointerPosition(); }

// ===== ステージイベント(作図/パン/選択) =====
function setupStageEvents() {
  let panning = false, panStart = null, stageStart = null;

  S.stage.on('mousedown', e => {
    const mid = e.evt.button === 1;
    if (S.tool === 'pan' || S._spacePan || mid) {
      panning = true; panStart = S.stage.getPointerPosition(); stageStart = S.stage.position();
      S.stage.container().style.cursor = 'grabbing'; return;
    }
    if (S.calib) { onCalibClick(imgPos()); return; }
    if (S.tool === 'legend') {
      if (!S.draft) { S.draft = [imgPos()]; drawPreview(imgPos()); }
      else finishLegend(S.draft[0], imgPos());
      return;
    }
    const cat = CATS[S.tool];
    if (!cat) return; // 選択ツール等
    if (cat.kind === 'stamp') { addStamp(S.tool, imgPos()); return; }
    if (cat.kind === 'line' || cat.kind === 'area') {
      const p = snap(imgPos());
      if (!S.draft) S.draft = [];
      // 始点クリックで閉じる(範囲)
      if (cat.kind === 'area' && S.draft.length >= 3 && near(p, S.draft[0])) { finishDraft(); return; }
      // ダブルクリックで確定(直前クリックの近くを短時間に再クリック)
      const now = Date.now(), minPt = cat.kind === 'line' ? 2 : 3;
      if (S.draft.length >= minPt && S._lastClickT && now - S._lastClickT < 400 && S.draft.length && near(p, S.draft[S.draft.length - 1])) {
        S._lastClickT = 0; finishDraft(); return;
      }
      S._lastClickT = now;
      S.draft.push(p); drawPreview(p);
    }
  });

  S.stage.on('mousemove', () => {
    lastPointer = imgPos();
    if (panning) {
      const pos = S.stage.getPointerPosition();
      S.stage.position({ x: stageStart.x + (pos.x - panStart.x), y: stageStart.y + (pos.y - panStart.y) });
      S.stage.batchDraw(); return;
    }
    if (S.draft || S.calib) drawPreview(lastPointer);
  });

  S.stage.on('mouseup', () => { if (panning) { panning = false; S.stage.container().style.cursor = (S.tool === 'pan' || S._spacePan) ? 'grab' : (S.tool === 'select' ? 'default' : 'crosshair'); } });
  S.stage.on('dblclick', () => { if (S.draft) finishDraft(); });

  // 選択
  S.stage.on('click', e => {
    if (S.tool !== 'select') return;
    if (e.target === S.stage || e.target.getLayer() === S.bgLayer) { selectElement(null); return; }
    const el = findElByNode(e.target);
    if (el) selectElement(el);
  });
}

// クリックされたノードから上位をたどって対応する要素を探す(段数ラベル経由の選択にも対応)
function findElByNode(target) { let n = target; for (let i = 0; i < 4 && n; i++) { const el = S.elements.find(e => e.node === n); if (el) return el; n = n.getParent(); } return null; }

// ===== スナップ(ブロック等への吸い付きは廃止) =====
function nearestOnSeg(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1; let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2; t = Math.max(0, Math.min(1, t)); return { x: a.x + dx * t, y: a.y + dy * t }; }
function snap(p) {
  // 自分の作図始点にだけ吸着(図形を閉じるため)。他要素(ブロック等)へは吸い付かない
  if (S.draft && S.draft.length) { const q = S.draft[0]; if (Math.hypot(q.x - p.x, q.y - p.y) < SNAP_PX / S.stage.scaleX()) return { x: q.x, y: q.y }; }
  if (S._shift && S.draft && S.draft.length) {   // Shiftで直角・45°
    const a = S.draft[S.draft.length - 1], dx = p.x - a.x, dy = p.y - a.y;
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }
  return { x: p.x, y: p.y };
}
function near(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) < SNAP_PX / S.stage.scaleX(); }

// ===== 作図プレビュー =====
function drawPreview(p) {
  S.previewLayer.destroyChildren();
  if (S.calib) { drawCalibPreview(p); S.previewLayer.batchDraw(); return; }
  if (!S.draft) { S.previewLayer.batchDraw(); return; }
  if (S.tool === 'legend') { drawLegendPreview(p); S.previewLayer.batchDraw(); return; }
  const cat = CATS[S.tool];
  const pts = S.draft.concat(p ? [snap(p)] : []);
  const flat = pts.flatMap(q => [q.x, q.y]);
  S.previewLayer.add(new Konva.Line({
    points: flat, stroke: cat.color, strokeWidth: 2, strokeScaleEnabled: false,
    closed: false, dash: [6, 4], lineJoin: 'round',
  }));
  pts.forEach(q => S.previewLayer.add(new Konva.Circle({ x: q.x, y: q.y, radius: 4, fill: '#fff', stroke: cat.color, strokeWidth: 1.5, strokeScaleEnabled: false })));
  // ライブ数量
  const label = cat.kind === 'line' ? fmt(polylineLen(pts) * S.mPerPx, 'm') : fmt(polyArea(pts) * S.mPerPx * S.mPerPx, '㎡');
  if (S.mPerPx) {
    const c = centroid(pts);
    S.previewLayer.add(new Konva.Label({ x: c.x, y: c.y }).add(new Konva.Tag({ fill: '#111827cc', cornerRadius: 3 })).add(new Konva.Text({ text: label, fill: '#fff', padding: 3, fontSize: 13 / S.stage.scaleX() })));
  }
  S.previewLayer.batchDraw();
}

function finishDraft() {
  if (!S.draft) return;
  if (S.tool === 'legend') return; // 凡例は2クリックで確定するため対象外
  const cat = CATS[S.tool];
  // 連続する重複頂点を除去(ダブルクリック確定時の重なり対策)
  const thr = 2 / S.stage.scaleX(), pts = [];
  for (const p of S.draft) if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) > thr) pts.push(p);
  S.draft = pts;
  const min = cat.kind === 'line' ? 2 : 3;
  if (S.draft.length < min) { cancelDraft(); return; }
  const el = { id: S.idSeq++, cat: S.tool, points: S.draft.map(p => ({ x: p.x, y: p.y })) };
  if (S.tool === 'block_normal') el.dan = parseInt(document.getElementById('blockDan').value, 10);
  else if (S.tool === 'block_curb') el.dan = 0;
  S.elements.push(el);
  S.draft = null; S.previewLayer.destroyChildren(); S.previewLayer.batchDraw();
  renderElement(el); recalc();
}
function cancelDraft() { S.draft = null; S.previewLayer.destroyChildren(); S.previewLayer.batchDraw(); }

// ===== 要素描画(Konva) =====
function renderElement(el) {
  el.node = buildNode(el);
  el.node.draggable(S.tool === 'select');
  el.node.on('dragstart', () => { el._dragStart = { x: el.node.x(), y: el.node.y() }; }); // 開始位置を記録(凡例/スタンプは原点≠0)
  el.node.on('dragend', () => onDragEnd(el));
  S.shapeLayer.add(el.node);
  S.shapeLayer.batchDraw();
}
function rebuildElement(el) { const d = el.node ? el.node.draggable() : (S.tool === 'select'); if (el.node) el.node.destroy(); renderElement(el); el.node.draggable(d); }
function onDragEnd(el) {
  const s = el._dragStart || { x: 0, y: 0 };                 // 開始位置との差分が真の移動量
  const dx = el.node.x() - s.x, dy = el.node.y() - s.y;
  el.points = el.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
  if (el.labelPos) el.labelPos = { x: el.labelPos.x + dx, y: el.labelPos.y + dy };
  rebuildElement(el); recalc();
}
function addStamp(cat, p) { const el = { id: S.idSeq++, cat, points: [{ x: p.x, y: p.y }] }; S.elements.push(el); renderElement(el); recalc(); }

// 1要素のKonvaノードを生成(スタイル別)
function buildNode(el) {
  if (el.cat === 'legend') return buildLegendNode(el);
  const cat = CATS[el.cat];
  const flat = el.points.flatMap(p => [p.x, p.y]);
  if (cat.kind === 'line') {
    const g = new Konva.Group();
    g.add(new Konva.Line({ points: flat, stroke: cat.color, strokeWidth: lineW('line'), strokeScaleEnabled: true, lineCap: 'butt', lineJoin: 'round', hitStrokeWidth: 16 }));
    // 段数/種別ラベル(白背景・ドラッグで移動可。位置はlabelPosに保存)
    const lp = el.labelPos || polylineMidpoint(el.points);
    const txt = el.cat === 'block_curb' ? '地先' : `${el.dan}段`;
    const fz = S.mPerPx ? Math.max(0.32 / S.mPerPx, 9) : 13;
    const lab = new Konva.Label({ x: lp.x, y: lp.y, draggable: S.tool === 'select' });
    lab.add(new Konva.Tag({ fill: '#ffffff', stroke: cat.color, strokeWidth: Math.max(fz * 0.04, 0.6), cornerRadius: fz * 0.25 }));
    lab.add(new Konva.Text({ text: txt, fill: cat.color, fontStyle: 'bold', fontFamily: 'sans-serif', fontSize: fz, padding: fz * 0.18 }));
    lab.offsetX(lab.width() / 2); lab.offsetY(lab.height() / 2);   // lpを中心に配置
    lab.on('dragmove dragend', () => { el.labelPos = { x: lab.x(), y: lab.y() }; });
    lab.on('dragend', () => recalc());
    el._label = lab;
    g.add(lab);
    return g;
  }
  if (cat.kind === 'stamp') {           // 枠線のみ。配置図の縮尺に追従(実寸サイズでズームと一緒に拡縮)
    const p = el.points[0]; const r = stampRadius(); const lw = Math.max(r * 0.2, 1.4); const g = new Konva.Group({ x: p.x, y: p.y });
    g.add(new Konva.Circle({ radius: r, stroke: cat.color, strokeWidth: lw, fill: '#ffffff' }));
    g.add(new Konva.Text({ text: cat.mark, fill: cat.color, fontStyle: 'bold', fontSize: r * 1.4, width: r * 2, height: r * 2, align: 'center', verticalAlign: 'middle', x: -r, y: -r }));
    return g;
  }
  // area
  const g = new Konva.Group();
  if (cat.style === 'hatch') {          // 外枠 + 2重斜線(線は描いた範囲の内側に収める)
    const ins = insetPolygon(el.points, lineW('line') / 2 + 1);
    const hatch = new Konva.Group({ clipFunc: c => { c.beginPath(); ins.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.closePath(); } });
    const w = lineW('line');
    hatchSegments(ins).forEach(s => hatch.add(new Konva.Line({ points: s, stroke: cat.color, strokeWidth: w, strokeScaleEnabled: true, listening: false })));
    g.add(hatch);
    g.add(new Konva.Line({ points: ins.flatMap(p => [p.x, p.y]), closed: true, stroke: cat.color, strokeWidth: lineW('line'), strokeScaleEnabled: true }));
  } else if (cat.style === 'cross') {   // ×印を散布(外枠なし)。太さはブロック線と同じ
    const w = lineW('line');
    crossCenters(el.points).forEach(c => {
      g.add(new Konva.Line({ points: [c.x - c.s, c.y - c.s, c.x + c.s, c.y + c.s], stroke: cat.color, strokeWidth: w, strokeScaleEnabled: true, listening: false }));
      g.add(new Konva.Line({ points: [c.x - c.s, c.y + c.s, c.x + c.s, c.y - c.s], stroke: cat.color, strokeWidth: w, strokeScaleEnabled: true, listening: false }));
    });
  } else {                               // 砕石・階段下地: 薄塗り+枠
    g.add(new Konva.Line({ points: flat, closed: true, fill: cat.color + '40', stroke: cat.color, strokeWidth: lineW('area'), strokeScaleEnabled: true }));
  }
  g.add(new Konva.Line({ points: flat, closed: true, fill: 'rgba(0,0,0,0.001)' })); // 選択用の当たり判定
  return g;
}
function keepStampSizes() { /* スタンプは実寸サイズで縮尺追従するため何もしない */ }

// ===== 凡例スタンプ(長方形を描いて枠内に自動レイアウト) =====
function legendRect(el) { const xs = el.points.map(p => p.x), ys = el.points.map(p => p.y); const x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; }
function setLegendRect(el, r) { el.points = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]; }
function drawLegendPreview(p) {
  const a = S.draft[0];
  S.previewLayer.add(new Konva.Rect({ x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), width: Math.abs(p.x - a.x), height: Math.abs(p.y - a.y), stroke: '#111', strokeWidth: 1.5, strokeScaleEnabled: false, dash: [6, 4], fill: 'rgba(255,255,255,0.4)' }));
}
function finishLegend(a, b) {
  S.draft = null; S.previewLayer.destroyChildren(); S.previewLayer.batchDraw();
  if (Math.abs(a.x - b.x) < 12 || Math.abs(a.y - b.y) < 12) return; // 小さすぎる枠は無視
  const el = { id: S.idSeq++, cat: 'legend', points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }] };
  S.elements.push(el); renderElement(el); recalc();
  setTool('select'); selectElement(el);
}
// 現場で実際に使った項目のみ
function usedCats() {
  const agg = aggregate(), items = [];
  for (const key in CATS) {
    const cat = CATS[key], a = agg[key];
    if (key === 'block_normal') {
      // 普通ブロックは段数ごとに行を分け、段別の距離を表示
      Object.keys(a.sub || {}).sort((x, y) => parseInt(x, 10) - parseInt(y, 10)).forEach(k => {
        if (a.sub[k] > 0.005) items.push({ key, cat, qty: a.sub[k], label: `${cat.label} ${k}` });
      });
    } else {
      const used = cat.kind === 'stamp' ? a.qty > 0 : a.qty > 0.005;
      if (used) items.push({ key, cat, qty: a.qty, label: cat.label });
    }
  }
  return items;
}
function legendQty(it) {
  if (it.cat.kind === 'stamp') return it.qty;
  if (!S.mPerPx) return '0';
  return it.key === 'stairs' ? Math.round(it.qty) : it.qty.toFixed(2);   // 階段は整数の段数
}
function legendName(it) { return it.label || it.cat.label; }
// 凡例の見本アイコン(各カテゴリの描写スタイルを縮小再現)
function legendIcon(it, x, y, sz) {
  const cat = it.cat, out = [], cx = x + sz / 2, cy = y + sz / 2, lw = Math.max(sz * 0.13, 1.4);
  if (cat.kind === 'line') {
    out.push(new Konva.Line({ points: [x + sz * 0.05, cy, x + sz * 0.95, cy], stroke: cat.color, strokeWidth: lw, lineCap: 'round' }));
  } else if (cat.kind === 'stamp') {
    out.push(new Konva.Circle({ x: cx, y: cy, radius: sz * 0.42, stroke: cat.color, strokeWidth: lw * 0.9, fillEnabled: false }));
    out.push(new Konva.Text({ text: cat.mark, fill: cat.color, fontStyle: 'bold', fontSize: sz * 0.7, width: sz, height: sz, align: 'center', verticalAlign: 'middle', x, y }));
  } else if (cat.style === 'hatch') {
    out.push(new Konva.Rect({ x: x + sz * 0.1, y: y + sz * 0.22, width: sz * 0.8, height: sz * 0.56, stroke: cat.color, strokeWidth: lw * 0.8 }));
    out.push(new Konva.Line({ points: [x + sz * 0.22, y + sz * 0.78, x + sz * 0.5, y + sz * 0.22], stroke: cat.color, strokeWidth: lw * 0.7 }));
    out.push(new Konva.Line({ points: [x + sz * 0.5, y + sz * 0.78, x + sz * 0.78, y + sz * 0.22], stroke: cat.color, strokeWidth: lw * 0.7 }));
  } else if (cat.style === 'cross') {
    const s = sz * 0.24;
    out.push(new Konva.Line({ points: [cx - s, cy - s, cx + s, cy + s], stroke: cat.color, strokeWidth: lw }));
    out.push(new Konva.Line({ points: [cx - s, cy + s, cx + s, cy - s], stroke: cat.color, strokeWidth: lw }));
  } else {
    out.push(new Konva.Rect({ x: x + sz * 0.1, y: y + sz * 0.22, width: sz * 0.8, height: sz * 0.56, fill: cat.color + '66', stroke: cat.color, strokeWidth: lw * 0.6 }));
  }
  return out;
}
// 文字幅の計測(指定px相当)。fontFamilyはKonvaの描画と合わせる
let _measCtx;
function measureText(t, fz) { if (!_measCtx) _measCtx = document.createElement('canvas').getContext('2d'); _measCtx.font = `${fz}px sans-serif`; return _measCtx.measureText(t).width; }
function legendLabel(it) { return `${legendName(it)} ${legendQty(it)}${it.cat.unit}`; }
// 枠(長方形)の中に必ず全項目が収まるよう、列数とフォントを自動決定
function buildLegendNode(el) {
  const R = legendRect(el);
  const g = new Konva.Group({ x: R.x, y: R.y });
  g.add(new Konva.Rect({ width: R.w, height: R.h, fill: 'rgba(255,255,255,0.92)', stroke: '#333', strokeWidth: Math.max(Math.min(R.w, R.h) * 0.012, 1) }));
  const items = usedCats();
  const pad = Math.min(R.w, R.h) * 0.05;
  const innerX = pad, innerW = R.w - pad * 2;
  // タイトル「凡例」: 縦長/横長で差が出ないよう、枠の幾何平均√(幅×高さ)を基準にサイズを決める
  // (縦横を入れ替えても幾何平均は不変なので大きさが揃う。高さ・幅の上限で枠からはみ出さないよう調整)
  const titleFz = Math.max(9, Math.min(Math.sqrt(R.w * R.h) * 0.11, R.h * 0.28, innerW / 2.4));
  const titleH = titleFz * 1.35;
  g.add(new Konva.Text({ text: '凡例', x: innerX, y: pad * 0.35, width: innerW, height: titleH, align: 'center', verticalAlign: 'middle', fontStyle: 'bold', fontFamily: 'sans-serif', fill: '#111', fontSize: titleFz }));
  if (!items.length) return g;
  const gridY = pad * 0.35 + titleH, gridH = R.h - gridY - pad * 0.5, n = items.length;
  // 各列数で「枠に収まる最大フォント」を算出
  const cands = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), cw = innerW / cols, ch = gridH / rows;
    if (ch <= 3 || cw <= 6) continue;
    const icon = Math.min(ch * 0.6, cw * 0.26), gap = cw * 0.04;
    const textW = cw - icon - gap * 2 - cw * 0.02;
    if (textW <= 4) continue;
    let fit = ch * 0.34;                                 // 高さ上限(名称+数量の2行)
    for (const it of items) { const w = Math.max(measureText(legendName(it), 100), measureText(`${legendQty(it)}${it.cat.unit}`, 100)); fit = Math.min(fit, textW / (w * 1.04) * 100); } // 幅上限
    cands.push({ cols, rows, cw, ch, icon, gap, fit: Math.max(fit, 0) });
  }
  if (!cands.length) return g;
  // 希望フォント(実寸×倍率)を満たす中で最も列数が多い配置。無ければ最大フォントの配置
  const maxFit = cands.reduce((a, b) => b.fit > a.fit ? b : a);
  const target = maxFit.fit * 0.8 * (el.fontScale || 1); // 既定で枠をしっかり埋める。±ボタンで微調整
  const ok = cands.filter(c => c.fit >= target);
  const ch0 = ok.length ? ok.reduce((a, b) => b.cols > a.cols ? b : a) : maxFit;
  const fz = Math.min(target, ch0.fit), { cols, cw, ch, icon, gap } = ch0;
  items.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const cx = innerX + c * cw, cy = gridY + r * ch;
    legendIcon(it, cx + gap, cy + (ch - icon) / 2, icon).forEach(s => g.add(s));
    const tx = cx + gap + icon + gap;
    g.add(new Konva.Text({ text: legendName(it), x: tx, y: cy, height: ch * 0.5, verticalAlign: 'bottom', fontFamily: 'sans-serif', fontStyle: 'bold', fill: '#111', fontSize: fz }));
    g.add(new Konva.Text({ text: `${legendQty(it)}${it.cat.unit}`, x: tx, y: cy + ch * 0.5, height: ch * 0.5, verticalAlign: 'top', fontFamily: 'sans-serif', fill: '#374151', fontSize: fz * 0.95 }));
  });
  return g;
}

// 斜線/×印の生成(Konvaとエクスポート両方で使用)
function hatchSegments(poly) {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const gap = Math.max(2.5 / (S.mPerPx || 0.012), 20), pg = Math.max(0.216 / (S.mPerPx || 0.012), 6);
  const segs = [];
  for (let k = minX - maxY; k <= maxX - minY; k += gap)
    for (const off of [0, pg]) segs.push([minX, minX - (k + off), maxX, maxX - (k + off)]);
  return segs;
}
// 庭の×: 細かく候補を出し→疎に間引く。疎を保ちつつ細い部分も必ず拾える
function crossCenters(poly) {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const step = Math.max(1.6 / (S.mPerPx || 0.012), 24);    // ×同士の最小間隔(密度2倍)
  const s = Math.max(0.15 / (S.mPerPx || 0.012), 4);       // ×の腕長(標準)
  const fine = Math.max(step / 5, 4);                       // 候補の細かさ(細い部分も拾うため)
  const clearance = Math.max(0.05 / (S.mPerPx || 0.012), 2);
  const minMark = Math.max(0.04 / (S.mPerPx || 0.012), 3);  // これ未満の細さは描かない
  const min2 = step * step, acc = [];
  // minMargin: 縁からこの距離以上内側の候補のみ。sizeFn(d)で×のサイズを決める
  function pass(minMargin, sizeFn) {
    for (let y = minY + fine / 2; y < maxY; y += fine)
      for (let x = minX + fine / 2; x < maxX; x += fine) {
        if (!pointInPoly(x, y, poly)) continue;
        const d = distToPoly(x, y, poly);
        if (d < minMargin) continue;
        let ok = true;
        for (const a of acc) { const dx = a.x - x, dy = a.y - y; if (dx * dx + dy * dy < min2) { ok = false; break; } }
        if (ok) acc.push({ x, y, s: sizeFn(d) });
      }
  }
  pass(s + clearance, () => s);              // ①広い所: 縁から余裕、標準サイズ
  pass(s, () => s);                          // ②中: ×が縁に収まる範囲、標準サイズ
  pass(minMark, d => Math.min(d * 0.85, s)); // ③細い所: 局所幅に収まる小さい×
  if (!acc.length) { const c = centroid(poly); if (pointInPoly(c.x, c.y, poly)) acc.push({ x: c.x, y: c.y, s: Math.min((distToPoly(c.x, c.y, poly) || s) * 0.85, s) }); }
  return acc;
}
// 点から多角形の各辺までの最短距離
function distToPoly(x, y, poly) {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const q = nearestOnSeg({ x, y }, poly[i], poly[(i + 1) % poly.length]);
    const d = Math.hypot(q.x - x, q.y - y); if (d < m) m = d;
  }
  return m;
}

// ===== 選択/削除 =====
function selectElement(el) {
  S.selected = el;
  S.previewLayer.destroyChildren();
  const box = document.getElementById('selInfo');
  if (!el) { box.textContent = 'なし'; S.previewLayer.batchDraw(); return; }
  // 外接枠ハイライト
  let x, y, w, h;
  if (el.cat === 'legend') { const r = el.node.getClientRect({ relativeTo: S.shapeLayer }); x = r.x; y = r.y; w = r.width; h = r.height; }
  else { const xs = el.points.map(p => p.x), ys = el.points.map(p => p.y); x = Math.min(...xs); y = Math.min(...ys); w = Math.max(...xs) - x; h = Math.max(...ys) - y; }
  S.previewLayer.add(new Konva.Rect({ x: x - 8, y: y - 8, width: w + 16, height: h + 16, stroke: '#2563eb', strokeWidth: 1.5, strokeScaleEnabled: false, dash: [6, 4], listening: false }));
  S.previewLayer.batchDraw();
  if (el.cat === 'legend') {
    // 四隅にリサイズハンドル(ドラッグで枠を変形→中身を再レイアウト)
    const r = legendRect(el), hs = 6 / S.stage.scaleX();
    const corners = [{ k: 'tl', x: r.x, y: r.y }, { k: 'tr', x: r.x + r.w, y: r.y }, { k: 'bl', x: r.x, y: r.y + r.h }, { k: 'br', x: r.x + r.w, y: r.y + r.h }];
    corners.forEach(cn => {
      const h = new Konva.Rect({ x: cn.x - hs, y: cn.y - hs, width: hs * 2, height: hs * 2, fill: '#2563eb', stroke: '#fff', strokeWidth: 1, strokeScaleEnabled: false, draggable: true });
      h.on('dragmove', () => {
        const nx = h.x() + hs, ny = h.y() + hs, rr = legendRect(el);
        let x0 = rr.x, y0 = rr.y, x1 = rr.x + rr.w, y1 = rr.y + rr.h;
        if (cn.k[0] === 't') y0 = ny; else y1 = ny;
        if (cn.k[1] === 'l') x0 = nx; else x1 = nx;
        setLegendRect(el, { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
        rebuildElement(el);
      });
      h.on('dragend', () => { recalc(); selectElement(el); });
      S.previewLayer.add(h);
    });
    S.previewLayer.batchDraw();
    box.innerHTML = `<div class="row"><b>凡例スタンプ</b></div>`
      + `<div class="row"><span>文字サイズ</span><span><button class="szbtn" onclick="legendFont(-1)">−</button> <button class="szbtn" onclick="legendFont(1)">＋</button></span></div>`
      + `<div class="hint" style="margin:4px 0">枠が小さいと自動で縮小されます。大きくしたいときは四隅で枠を広げてください。</div>`
      + `<button class="del" onclick="deleteSelected()">削除</button>`;
    return;
  }
  const cat = CATS[el.cat];
  if (cat.kind === 'line' || cat.kind === 'area') {
    // 各頂点にハンドル(ドラッグで頂点調整)
    const hs = 5 / S.stage.scaleX();
    el.points.forEach((pt, i) => {
      const h = new Konva.Circle({ x: pt.x, y: pt.y, radius: hs, fill: '#fff', stroke: '#2563eb', strokeWidth: 1.5, strokeScaleEnabled: false, draggable: true });
      h.on('dragmove', () => { el.points[i] = { x: h.x(), y: h.y() }; rebuildElement(el); });
      h.on('dragend', () => { recalc(); selectElement(el); });
      S.previewLayer.add(h);
    });
    S.previewLayer.batchDraw();
  }
  let html = `<div class="row"><b>${cat.label}</b></div>`;
  if (cat.kind === 'line') {
    html += `<div class="row"><span>延長</span><b>${fmt(polylineLen(el.points) * S.mPerPx, 'm')}</b></div>`;
    if (el.cat === 'block_normal') {
      html += `<div class="row"><span>段数</span><select onchange="changeDan(this.value)">`
        + [1, 2, 3, 4, 5].map(n => `<option value="${n}"${n === el.dan ? ' selected' : ''}>${n}段</option>`).join('')
        + `</select></div>`;
    } else if (el.cat === 'block_curb') {
      html += `<div class="row"><span>種別</span><span>地先</span></div>`;
    }
  } else if (cat.kind === 'area') {
    if (el.cat === 'stairs') {
      const sm = stairsShortM(el);
      html += `<div class="row"><span>短手</span><b>${S.mPerPx ? sm.toFixed(2) + ' m' : '—'}</b></div>`;
      html += `<div class="row"><span>段数</span><b>${stairsStepCount(el)}段</b></div>`;
    } else {
      html += `<div class="row"><span>面積</span><b>${fmt(polyArea(el.points) * S.mPerPx * S.mPerPx, '㎡')}</b></div>`;
    }
  } else html += `<div class="row"><span>スタンプ</span><span>1個</span></div>`;
  if (CONVERT[el.cat]) html += `<button class="del" style="background:#2563eb;display:block;width:100%;margin-top:8px" onclick="changeCat()">${CATS[CONVERT[el.cat]].label}に変更</button>`;
  html += `<button class="del" onclick="deleteSelected()">削除</button>`;
  box.innerHTML = html;
}
function changeDan(v) {
  const el = S.selected; if (!el || el.cat !== 'block_normal') return;
  el.dan = parseInt(v, 10); rebuildElement(el); recalc(); selectElement(el);
}
// 種別の相互変換(アスファルト⇄砕石 / 普通ブロック⇄地先ブロック)
const CONVERT = { asphalt: 'gravel', gravel: 'asphalt', block_normal: 'block_curb', block_curb: 'block_normal' };
function changeCat() {
  const el = S.selected; if (!el) return;
  const to = CONVERT[el.cat]; if (!to) return;
  el.cat = to;
  if (to === 'block_curb') el.dan = 0;                                  // 地先は0段
  else if (to === 'block_normal') el.dan = (el.dan && el.dan > 0) ? el.dan : 2; // 普通は段数が要る(既定2)
  rebuildElement(el); recalc(); selectElement(el);
}
function legendFont(d) {
  const el = S.selected; if (!el || el.cat !== 'legend') return;
  el.fontScale = Math.max(0.4, Math.min(4, (el.fontScale || 1) * (d > 0 ? 1.18 : 0.85)));
  rebuildElement(el); recalc(); selectElement(el);
}
function deleteSelected() {
  if (!S.selected) return;
  S.selected.node.destroy(); S.elements = S.elements.filter(e => e !== S.selected);
  S.selected = null; document.getElementById('selInfo').textContent = 'なし';
  S.shapeLayer.batchDraw(); recalc();
}
// ===== 縮尺(1/100・1/150をボタンで選択) =====
function setScale(denom) {
  S.scaleDenom = denom;
  S.mPerPx = 0.000352778 * denom / 2.5;   // RS=2.5でレンダしているため
  updateScaleInfo('1/' + denom); markScaleButtons();
  restyleStrokes(); recalc();
}
function markScaleButtons() {   // 縮尺ドロップダウンに現在値を反映(関数名は従来の呼び出し元に合わせて維持)
  const sel = document.getElementById('scaleSelect');
  if (sel) sel.value = S.scaleDenom ? String(S.scaleDenom) : '';
}
function clearCalib() { S.calib = null; S.previewLayer.destroyChildren(); S.previewLayer.batchDraw(); }
function onCalibClick(p) {
  S.calib.pts.push(p);
  if (S.calib.pts.length === 2) {
    const d = Math.hypot(S.calib.pts[0].x - S.calib.pts[1].x, S.calib.pts[0].y - S.calib.pts[1].y);
    const m = parseFloat(prompt('この2点間の実寸(m)を入力', '1'));
    if (m > 0) { S.mPerPx = m / d; S.scaleDenom = null; updateScaleInfo('手動'); recalc(); restyleStrokes(); }
    clearCalib();
  }
}
function drawCalibPreview(p) {
  if (!S.calib || !S.calib.pts.length) return;
  const a = S.calib.pts[0];
  S.previewLayer.add(new Konva.Line({ points: [a.x, a.y, p.x, p.y], stroke: '#f59e0b', strokeWidth: 2, strokeScaleEnabled: false, dash: [5, 5] }));
}

// ===== 幾何 =====
function polylineLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return s; }
// 折れ線の中点(全長の半分の位置)。段数ラベルの既定位置に使う
function polylineMidpoint(pts) {
  if (!pts || !pts.length) return { x: 0, y: 0 };
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y };
  const half = polylineLen(pts) / 2; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + d >= half) { const t = (half - acc) / (d || 1); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; }
    acc += d;
  }
  return centroid(pts);
}
function polyArea(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; } return Math.abs(a) / 2; }
// 階段下地: 段数判定用。最小面積の傾き付き外接矩形の短辺(px)を返す(手描きのブレ・回転に強い)
function minRectShortSide(pts) {
  if (!pts || pts.length < 2) return 0;
  let bestArea = Infinity, shortSide = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    let ux = b.x - a.x, uy = b.y - a.y; const L = Math.hypot(ux, uy); if (L < 1e-6) continue;
    ux /= L; uy /= L; const vx = -uy, vy = ux;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of pts) {
      const du = p.x * ux + p.y * uy, dv = p.x * vx + p.y * vy;
      if (du < minU) minU = du; if (du > maxU) maxU = du;
      if (dv < minV) minV = dv; if (dv > maxV) maxV = dv;
    }
    const w = maxU - minU, h = maxV - minV, area = w * h;
    if (area < bestArea) { bestArea = area; shortSide = Math.min(w, h); }
  }
  return shortSide;
}
const STEP_DEPTH = 0.3;   // 階段1段あたりの短手(m)。短手÷0.3を四捨五入して段数(手描きのズレを吸収)
function stairsShortM(el) { return S.mPerPx ? minRectShortSide(el.points) * S.mPerPx : 0; }
function stairsStepCount(el) { const m = stairsShortM(el); return m > 0 ? Math.max(1, Math.round(m / STEP_DEPTH)) : 0; }
function centroid(pts) { let x = 0, y = 0; pts.forEach(p => { x += p.x; y += p.y; }); return { x: x / pts.length, y: y / pts.length }; }
function vnorm(v) { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; }
function signedArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; } return a / 2; }
function pointInPoly(x, y, poly) { let inside = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside; } return inside; }
// 多角形を内側へd(px)オフセット(枠を内側に寄せてブロックと被らせない)
function insetPolygon(pts, d) {
  const n = pts.length; if (n < 3) return pts.slice();
  const sign = signedArea(pts) > 0 ? 1 : -1; const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const e1 = vnorm({ x: p1.x - p0.x, y: p1.y - p0.y }), e2 = vnorm({ x: p2.x - p1.x, y: p2.y - p1.y });
    const n1 = { x: e1.y * sign, y: -e1.x * sign }, n2 = { x: e2.y * sign, y: -e2.x * sign };
    const b = vnorm({ x: n1.x + n2.x, y: n1.y + n2.y });
    const cosA = Math.max(0.3, b.x * n1.x + b.y * n1.y);
    out.push({ x: p1.x + b.x * d / cosA, y: p1.y + b.y * d / cosA });
  }
  if (Math.abs(signedArea(out)) > Math.abs(signedArea(pts)))   // 外に出たら反転
    return pts.map((p, i) => ({ x: 2 * p.x - out[i].x, y: 2 * p.y - out[i].y }));
  return out;
}
function fmt(v, u) { if (v == null || isNaN(v)) return '— ' + u; return v.toFixed(u === 'm' ? 2 : 2) + ' ' + u; }

// ===== 集計 + 凡例 =====
// 重なり順(z-order): 数値が大きいほど前面。普通ブロック>地先>スタンプ>階段下地>アスファルト>砕石>庭。凡例は最前面。
const ZRANK = { garden: 0, gravel: 1, asphalt: 2, stairs: 3, post: 4, faucet: 4, camera: 4, block_curb: 5, block_normal: 6, legend: 7 };
function applyZOrder() {
  // 優先度の低い順に moveToTop していくと、最終的に高優先度が前面に並ぶ
  S.elements.slice().sort((a, b) => (ZRANK[a.cat] ?? 0) - (ZRANK[b.cat] ?? 0)).forEach(el => { if (el.node) el.node.moveToTop(); });
  S.shapeLayer.batchDraw();
}
function recalc() { renderLegend(); for (const el of S.elements) if (el.cat === 'legend' && el.node) rebuildElement(el); applyZOrder(); if (S.selected) selectElement(S.selected); if (S._loaded && !S._restoring) recordHistory(); scheduleSave(); }
// ===== 履歴(元に戻す/やり直す) =====
function recordHistory() {
  const snap = JSON.stringify(serializeState());
  if (!S.hist) { S.hist = []; S.hi = -1; }
  if (S.hist[S.hi] === snap) return;
  S.hist = S.hist.slice(0, S.hi + 1);
  S.hist.push(snap);
  if (S.hist.length > 80) S.hist.shift();
  S.hi = S.hist.length - 1;
  updateUndoRedoButtons();
}
function undo() { if (!S.hist || S.hi <= 0) return; S.hi--; S._restoring = true; loadStateData(JSON.parse(S.hist[S.hi])); S._restoring = false; updateUndoRedoButtons(); scheduleSave(); }
function redo() { if (!S.hist || S.hi >= S.hist.length - 1) return; S.hi++; S._restoring = true; loadStateData(JSON.parse(S.hist[S.hi])); S._restoring = false; updateUndoRedoButtons(); scheduleSave(); }
function updateUndoRedoButtons() {
  const u = document.getElementById('btnUndo'), r = document.getElementById('btnRedo');
  if (u) u.disabled = !(S.hist && S.hi > 0);
  if (r) r.disabled = !(S.hist && S.hi < S.hist.length - 1);
}
function aggregate() {
  const agg = {};
  for (const key in CATS) agg[key] = { qty: 0, sub: {} };
  for (const el of S.elements) {
    const cat = CATS[el.cat];
    if (!cat) continue; // 凡例スタンプ等は集計対象外
    if (!S.mPerPx && cat.kind !== 'stamp') continue;
    if (cat.kind === 'line') {
      const len = polylineLen(el.points) * S.mPerPx; agg[el.cat].qty += len;
      const k = (el.dan != null && el.dan > 0) ? el.dan + '段' : '';   // 地先(0段)は段別内訳を作らない
      if (k) agg[el.cat].sub[k] = (agg[el.cat].sub[k] || 0) + len;
    } else if (cat.kind === 'area') {
      if (el.cat === 'stairs') agg[el.cat].qty += stairsStepCount(el);   // 階段は面積でなく段数を集計
      else agg[el.cat].qty += polyArea(el.points) * S.mPerPx * S.mPerPx;
    } else { agg[el.cat].qty += 1; }
  }
  return agg;
}
function renderLegend() {
  const agg = aggregate();
  const box = document.getElementById('legendList'); box.innerHTML = '';
  for (const key in CATS) {
    const c = CATS[key], a = agg[key];
    const row = document.createElement('div'); row.className = 'legrow';
    const q = c.kind === 'stamp' ? a.qty : (S.mPerPx ? (key === 'stairs' ? Math.round(a.qty) : a.qty.toFixed(2)) : '—');
    row.innerHTML = `<span class="sw" style="background:${c.color}${c.kind==='area'?'66':''}"></span>`+
      `<span class="nm">${c.label}</span><span class="qt">${q}<small> ${c.unit}</small></span>`;
    box.appendChild(row);
    Object.entries(a.sub || {}).forEach(([k, v]) => { if (k) { const s = document.createElement('div'); s.className = 'legsub'; s.textContent = `${k}: ${v.toFixed(2)} m`; box.appendChild(s); } });
  }
}

// ===== PDF出力 =====
async function exportPDF() {
  if (!S.imgW) { alert('配置図を読み込んでください'); return; }
  // 背景+図形を画像座標の素解像度で合成
  const c = document.createElement('canvas'); c.width = S.imgW; c.height = S.imgH;
  const ctx = c.getContext('2d');
  ctx.drawImage(S.bgLayer.getChildren()[0].image(), 0, 0, S.imgW, S.imgH);
  for (const el of S.elements) drawElemToCtx(ctx, el);
  const img = c.toDataURL('image/jpeg', 0.92);

  const { jsPDF } = window.jspdf;
  const landscape = S.imgW >= S.imgH;
  const pdf = new jsPDF({ orientation: landscape ? 'l' : 'p', unit: 'mm', format: 'a3' });
  const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
  const m = 8; const aw = pw - m * 2, ah = ph - m * 2;
  const r = Math.min(aw / S.imgW, ah / S.imgH);
  pdf.addImage(img, 'JPEG', m, m, S.imgW * r, S.imgH * r);

  // ファイル名: 外構図_現場名_棟数棟_タイムスタンプ.pdf (どの現場か分かるように)
  const d = new Date(), z = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  const s = S.currentSite;
  const fname = (s ? `外構図_${s.site}_${s.buildings || 1}棟_${ts}` : `外構図_${ts}`).replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
  pdf.save(fname);                                   // 端末にもダウンロード(従来どおり)

  // Driveの現場フォルダにも保存(ローカルファイルを直接開いた場合はスキップ)
  if (s && S.siteKey) {
    showLoading('Googleドライブへ保存中…');
    try {
      const resp = await fetch('/api/export?key=' + encodeURIComponent(S.siteKey), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdf.output('blob') });
      const j = await resp.json().catch(() => ({}));
      hideLoading();
      if (resp.ok && j.ok) alert('Googleドライブに保存しました:\n' + j.path);
      else alert('ドライブへの保存に失敗しました。\n' + (j.error || 'エラー ' + resp.status) + '\n(端末へのダウンロードは完了しています)');
    } catch (e) {
      hideLoading();
      alert('ドライブへの保存に失敗しました(通信エラー)。\n端末へのダウンロードは完了しています。');
    }
  }
}
function pathCtx(ctx, pts, close) { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); if (close) ctx.closePath(); }
function drawElemToCtx(ctx, el) {
  if (el.cat === 'legend') {            // 既存のKonvaノードを画像化して合成
    if (!el.node) return;
    const r = el.node.getClientRect({ relativeTo: S.shapeLayer });
    const cnv = el.node.toCanvas({ pixelRatio: 2 });
    ctx.drawImage(cnv, r.x, r.y, r.width, r.height); return;
  }
  const cat = CATS[el.cat];
  if (cat.kind === 'stamp') {           // 枠線のみ
    const p = el.points[0], r = stampRadius(), lw = Math.max(r * 0.2, 1.4);
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = cat.color; ctx.lineWidth = lw; ctx.stroke();
    ctx.fillStyle = cat.color; ctx.font = `bold ${(r * 1.4).toFixed(0)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(cat.mark, p.x, p.y); return;
  }
  if (cat.kind === 'line') {
    pathCtx(ctx, el.points, false); ctx.strokeStyle = cat.color; ctx.lineWidth = lineW('line'); ctx.lineCap = 'butt'; ctx.lineJoin = 'round'; ctx.stroke();
    // 段数/種別ラベル
    const lp = el.labelPos || polylineMidpoint(el.points);
    const txt = el.cat === 'block_curb' ? '地先' : `${el.dan}段`;
    const fz = S.mPerPx ? Math.max(0.32 / S.mPerPx, 9) : 13, pad = fz * 0.18;
    ctx.font = `bold ${fz.toFixed(0)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(lp.x - tw / 2 - pad, lp.y - fz / 2 - pad, tw + pad * 2, fz + pad * 2);
    ctx.strokeStyle = cat.color; ctx.lineWidth = Math.max(fz * 0.04, 0.6); ctx.strokeRect(lp.x - tw / 2 - pad, lp.y - fz / 2 - pad, tw + pad * 2, fz + pad * 2);
    ctx.fillStyle = cat.color; ctx.fillText(txt, lp.x, lp.y);
    return;
  }
  // area
  if (cat.style === 'hatch') {
    const ins = insetPolygon(el.points, lineW('line') / 2 + 1);
    ctx.save(); pathCtx(ctx, ins, true); ctx.clip();
    ctx.strokeStyle = cat.color; ctx.lineWidth = lineW('line');
    hatchSegments(ins).forEach(s => { ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); ctx.stroke(); });
    ctx.restore();
    pathCtx(ctx, ins, true); ctx.strokeStyle = cat.color; ctx.lineWidth = lineW('line'); ctx.stroke();
  } else if (cat.style === 'cross') {
    ctx.strokeStyle = cat.color; ctx.lineWidth = lineW('line');
    crossCenters(el.points).forEach(c => { ctx.beginPath(); ctx.moveTo(c.x - c.s, c.y - c.s); ctx.lineTo(c.x + c.s, c.y + c.s); ctx.moveTo(c.x - c.s, c.y + c.s); ctx.lineTo(c.x + c.s, c.y - c.s); ctx.stroke(); });
  } else {
    pathCtx(ctx, el.points, true); ctx.fillStyle = cat.color + '55'; ctx.fill(); ctx.strokeStyle = cat.color; ctx.lineWidth = lineW('area'); ctx.stroke();
  }
}

window.deleteSelected = deleteSelected;
window.changeDan = changeDan;
window.changeCat = changeCat;
init();
