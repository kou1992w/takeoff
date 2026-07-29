// =============================================
// 【使用しない・参考用】保存キー移行スクリプト（現場フォルダのリネームに追随する）
// =============================================
// ★ 2026-07-29 に保存キーを工事番号ベース（フォルダ名に依存しない）へ変更したため、
//   このスクリプトは**もう不要**です。フォルダ名が変わっても保存キーは変わりません。
//   → 現行の移行は migrate-to-stable-keys.js（一度きり・実行済み）。
//   例外として、図面ファイル名から工事番号(11桁)を取れない現場だけは従来のパス由来キーに
//   フォールバックするため、そういう現場が現れたときの参考として残しています（実データでは0件）。
// =============================================
// なぜ必要か:
//  このアプリの保存キーは **現場フォルダのパス文字列** そのもの（server.js の `key`）で、
//  保存ファイル名は `sha1(savekey).json`。つまり Drive 側で現場フォルダ名を変えると
//  ハッシュが変わり、保存済みの作図データが「未保存」に見えてしまう。
//  さらに配置図2枚目以降の savekey は `key#pid`、`pid = sha1(ファイルパス).slice(0,12)` なので
//  ファイルパスに含まれる現場フォルダ名が変わると pid も変わる。両方を作り直す必要がある。
//
// 使い方（a1-drawing-sync の rename-site-folders.js を実行した後）:
//   node migrate-save-keys.js --map ../../a1-drawing-sync/rename-map.json           ← ドライラン
//   node migrate-save-keys.js --map ../../a1-drawing-sync/rename-map.json --apply   ← 実行
//
// 入力 rename-map.json: [{ office, siteCode, siteName, folderId, from, to }, ...]
//   from/to は **Drive 上のフォルダ名**。Google ドライブ デスクトップのミラーリングでは
//   '/' が使えず半角スペースに置換されるため、ローカルパス照合では from の '/' をスペースにした
//   表記でも突き合わせる（旧形式 'YYYY/MM/DD_現場名' 対策）。
//
// やること:
//   1. sites.json の各現場について、旧 savekey → 新 savekey を算出
//   2. saves/<sha1(旧)>.json → saves/<sha1(新)>.json にリネーム（saves/backup/ も同様）
//   3. sites.json は退避して削除（次回起動時に再スキャンさせる。古いキャッシュを残さない）

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const APPLY = process.argv.includes("--apply");
const mapIdx = process.argv.indexOf("--map");
const MAP_PATH = mapIdx >= 0 && process.argv[mapIdx + 1] ? process.argv[mapIdx + 1] : "rename-map.json";

const SAVES = path.join(__dirname, "saves");
const BACKUPS = path.join(SAVES, "backup");
const CACHE = path.join(__dirname, "sites.json");

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const log = (m) => console.log(m);

// フォルダ名の表記ゆれ候補（Drive 実名 / ミラーリング時の '/'→' ' 置換版）
function nameVariants(name) {
  const v = new Set([name]);
  if (name.includes("/")) v.add(name.replace(/\//g, " "));
  return [...v];
}

// パスを区切りで分解し、セグメント一致した箇所だけ置換する（部分文字列置換にしない＝誤爆防止）
function applyRename(p, pairs) {
  if (!p) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  const segs = String(p).split(/[\\/]/);
  let hit = false;
  const out = segs.map((s) => {
    for (const { froms, to } of pairs) {
      if (froms.includes(s)) { hit = true; return to; }
    }
    return s;
  });
  return hit ? out.join(sep) : p;
}

function main() {
  if (!fs.existsSync(MAP_PATH)) {
    console.error(`対応表が見つかりません: ${MAP_PATH}`);
    console.error("先に a1-drawing-sync で `node rename-site-folders.js` を実行してください。");
    process.exit(1);
  }
  const rawMap = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  const pairs = rawMap.map((r) => ({ froms: nameVariants(r.from), to: r.to }));
  log(`対応表: ${pairs.length}件 (${MAP_PATH})`);
  if (!pairs.length) { log("変更対象がありません。終了します。"); return; }

  if (!fs.existsSync(CACHE)) {
    console.error(`sites.json がありません: ${CACHE}`);
    console.error("アプリを一度起動して現場一覧をスキャンさせてから実行してください。");
    process.exit(1);
  }
  const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const sites = cache.sites || [];

  // 旧 savekey → 新 savekey を算出
  const moves = [];   // { from, to, oldKey, newKey, label }
  for (const s of sites) {
    const newKey = applyRename(s.key, pairs);
    if (newKey === s.key) continue;                     // この現場は名前が変わらない
    for (const p of s.plans || []) {
      const oldSrc = p.file || p.path || "";
      const newSrc = applyRename(oldSrc, pairs);
      const oldSave = p.savekey;
      // 配置図の先頭(primary)は savekey=現場キー、それ以外は 現場キー#pid(pid=sha1(パス)先頭12桁)
      const isPrimary = !String(oldSave).includes("#");
      const newSave = isPrimary ? newKey : newKey + "#" + sha1(newSrc).slice(0, 12);
      if (oldSave === newSave) continue;
      moves.push({ oldKey: oldSave, newKey: newSave, label: `${s.site} / ${p.label || p.kind || ""}` });
    }
  }

  // 実ファイルの移動計画（saves と saves/backup）
  const plan = [];
  const backupFiles = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS) : [];
  for (const mv of moves) {
    const oldH = sha1(mv.oldKey), newH = sha1(mv.newKey);
    const src = path.join(SAVES, oldH + ".json");
    if (fs.existsSync(src)) {
      plan.push({ kind: "save", src, dest: path.join(SAVES, newH + ".json"), label: mv.label });
    }
    for (const f of backupFiles.filter((f) => f.startsWith(oldH + "_"))) {
      plan.push({ kind: "backup", src: path.join(BACKUPS, f), dest: path.join(BACKUPS, newH + f.slice(oldH.length)), label: mv.label });
    }
  }

  log(`--- 保存キーの変更: ${moves.length}件 / 実ファイルの移動: ${plan.length}件 ---`);
  plan.forEach((p, i) => log(`  ${i + 1}. [${p.kind}] ${p.label}\n      ${path.basename(p.src)} → ${path.basename(p.dest)}`));
  if (!plan.length) log("  （保存済みデータがある現場は対象にありませんでした）");

  if (!APPLY) {
    log("\nドライランのため何も変更していません。実行するには --apply を付けてください。");
    return;
  }

  let done = 0, err = 0;
  for (const p of plan) {
    try {
      if (fs.existsSync(p.dest)) { log(`  移動先が既にあるためスキップ: ${path.basename(p.dest)}`); continue; }
      fs.renameSync(p.src, p.dest);
      done++;
    } catch (e) { err++; log(`  移動失敗: ${path.basename(p.src)} / ${e.message}`); }
  }

  // 古い現場一覧キャッシュは退避して消す（次回起動で再スキャンさせる）
  try {
    fs.renameSync(CACHE, CACHE + "." + Date.now() + ".bak");
    log("sites.json を退避しました（次回起動時に再スキャンされます）");
  } catch (e) { log(`sites.json の退避に失敗: ${e.message}`); }

  log(`=== 完了: 成功 ${done}件 / 失敗 ${err}件 ===`);
}

main();
