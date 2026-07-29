// =============================================
// 保存キーの安定化 移行スクリプト（一度きり）
// =============================================
// 何をするか:
//  保存キーを「現場フォルダのパス文字列」から「工事番号ベースの不変キー」へ移す。
//   旧: I:\...\鶴岡\2026-08-20_酒田市東泉町 第2[#pid]     ← フォルダ名が変わると別物になる
//   新: S265503[#26550300200]                              ← 着手日が変わっても不変
//  保存先ファイル名は `sha1(savekey).json` なので、実体は saves/ 内のファイル名の付け替え。
//
// 使い方:
//   node migrate-to-stable-keys.js                                    ← ドライラン（変更しない）
//   node migrate-to-stable-keys.js --apply                            ← 実行
//   node migrate-to-stable-keys.js --rename-map ../rename-map.json    ← 現場フォルダをリネーム済みの環境
//
// 前提:
//  旧キーはパス文字列そのものなので、`sites.json` からその現場の旧 savekey を再現して探す。
//  **現場フォルダをリネームした後に再スキャンされた環境**では sites.json のパスが新しくなっていて
//  旧キーを再現できない。その場合は `--rename-map` に a1-drawing-sync の rename-map.json を渡すと、
//  新フォルダ名 → 旧フォルダ名 に戻した旧キー候補も探す（'/' がスペースに置換される
//  ドライブ デスクトップ表記も候補に含める）。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APPLY = process.argv.includes("--apply");
const rmIdx = process.argv.indexOf("--rename-map");
const RENAME_MAP = rmIdx >= 0 ? process.argv[rmIdx + 1] : "";
const SAVES = path.join(__dirname, "saves");
const BACKUPS = path.join(SAVES, "backup");
const CACHE = path.join(__dirname, "sites.json");

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const log = (m) => console.log(m);

// 現場フォルダのリネーム対応表（新名 → 旧名の逆引き）。リネーム済み環境で旧キーを復元するために使う。
const REVERSE = [];
if (RENAME_MAP) {
  if (!fs.existsSync(RENAME_MAP)) { console.error(`対応表が見つかりません: ${RENAME_MAP}`); process.exit(1); }
  for (const r of JSON.parse(fs.readFileSync(RENAME_MAP, "utf8"))) {
    const olds = new Set([r.from]);
    if (String(r.from).includes("/")) olds.add(String(r.from).replace(/\//g, " "));  // ミラーリング表記
    REVERSE.push({ to: r.to, olds: [...olds] });
  }
  log(`リネーム対応表: ${REVERSE.length}件（旧キーの復元に使います）`);
}

// パス文字列の「新フォルダ名」を「旧フォルダ名」に戻した候補を返す（自分自身も含む）
function oldKeyCandidates(key) {
  const out = [key];
  if (!REVERSE.length) return out;
  const segs = String(key).split(/[\\/]/);
  const sep = String(key).includes("\\") ? "\\" : "/";
  for (let i = 0; i < segs.length; i++) {
    const hit = REVERSE.find((r) => r.to === segs[i]);
    if (!hit) continue;
    for (const old of hit.olds) {
      const copy = segs.slice(); copy[i] = old;
      out.push(copy.join(sep));
    }
  }
  return out;
}

// server.js と同じ規則（変更したら両方直すこと）
function workNo(src) {
  const m = String(src || "").match(/\((\d{11})\)[^()\\/]*\.pdf$/i);
  return m ? m[1] : "";
}

function main() {
  if (!fs.existsSync(CACHE)) {
    console.error(`sites.json がありません: ${CACHE}`);
    console.error("アプリを一度起動して現場一覧をスキャンさせてから実行してください。");
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const sites = cache.sites || [];
  log(`現場: ${sites.length}件（scannedAt: ${cache.scannedAt || "?"}）`);

  const plan = [];   // { src, dest, label, kind }
  let noWork = 0;
  const backupFiles = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS) : [];

  for (const s of sites) {
    const plans = s.plans || [];
    // 現場の安定キー（現場内のどれかの図面の工事番号 上6桁）
    let stable = "";
    for (const p of plans) { const w = workNo(p.file || p.path); if (w) { stable = "S" + w.slice(0, 6); break; } }
    if (!stable) { noWork++; continue; }   // 工事番号が取れない現場は従来キーのまま（server.js もフォールバックする）

    for (const p of plans) {
      const src = p.file || p.path || "";
      const oldSave = String(p.savekey || "");
      const isPrimary = !oldSave.includes("#");
      const w = workNo(src);
      // 仮図判定: sites.json が古く kind を持たない場合はファイル名から見る
      const isKari = (p.kind === "仮図") || /仮図/.test(path.basename(src));
      const tail = w ? (w + (isKari ? "@k" : "")) : p.pid;
      const newSave = isPrimary ? stable : stable + "#" + tail;
      if (!oldSave || oldSave === newSave) continue;
      const newH = sha1(newSave);
      if (fs.existsSync(path.join(SAVES, newH + ".json"))) continue;   // 移行済み

      // 旧キーの候補を順に試す（リネーム済み環境では旧フォルダ名に戻した候補も見る）
      for (const cand of oldKeyCandidates(oldSave)) {
        const oldH = sha1(cand);
        const f = path.join(SAVES, oldH + ".json");
        const hits = backupFiles.filter((x) => x.startsWith(oldH + "_"));
        if (!fs.existsSync(f) && !hits.length) continue;
        if (fs.existsSync(f)) {
          plan.push({ kind: "save", src: f, dest: path.join(SAVES, newH + ".json"), label: `${s.site} / ${p.label || ""}` });
        }
        for (const b of hits) {
          plan.push({ kind: "backup", src: path.join(BACKUPS, b), dest: path.join(BACKUPS, newH + b.slice(oldH.length)), label: `${s.site} / ${p.label || ""}` });
        }
        break;   // 見つかった候補で確定
      }
    }
  }

  log(`--- 移行するファイル: ${plan.length}件（工事番号を取れない現場: ${noWork}件はそのまま） ---`);
  plan.forEach((p, i) => log(`  ${i + 1}. [${p.kind}] ${p.label}\n      ${path.basename(p.src)} → ${path.basename(p.dest)}`));
  if (!plan.length) log("  （移行が必要な保存データはありませんでした）");

  if (!APPLY) {
    log("\nドライランのため何も変更していません。実行するには --apply を付けてください。");
    return;
  }

  let done = 0, err = 0;
  for (const p of plan) {
    try {
      if (fs.existsSync(p.dest)) { log(`  移動先が既にあるためスキップ: ${path.basename(p.dest)}`); continue; }
      fs.copyFileSync(p.src, p.dest);   // 旧ファイルは消さずに残す（切り戻し用。saves は小さい）
      done++;
    } catch (e) { err++; log(`  移行失敗: ${path.basename(p.src)} / ${e.message}`); }
  }
  try {
    fs.renameSync(CACHE, CACHE + "." + Date.now() + ".bak");
    log("sites.json を退避しました（次回起動時に再スキャンされます）");
  } catch (e) { log(`sites.json の退避に失敗: ${e.message}`); }
  log(`=== 完了: 成功 ${done}件 / 失敗 ${err}件 ===`);
  log("※ 旧ファイルは saves/ に残してあります（切り戻し用）。問題なければ後日削除してください。");
}

main();
