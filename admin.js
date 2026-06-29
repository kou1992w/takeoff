/* 管理者ページ — 許可ユーザーの一覧・追加・削除
 * サーバ側で大元アカウント(OWNER)のみアクセス許可。/api/admin/allowlist を読み書き。
 */
'use strict';

const listEl = document.getElementById('list');
const msgEl = document.getElementById('msg');
let OWNER = '';

function setMsg(t, ok) { msgEl.textContent = t || ''; msgEl.className = 'msg ' + (ok ? 'ok' : 'warn'); }

function render(list, owner) {
  if (owner) OWNER = owner;
  document.getElementById('countInfo').textContent = `登録 ${list.length} 件`;
  listEl.innerHTML = '';
  list.slice().sort().forEach(em => {
    const row = document.createElement('div'); row.className = 'urow';
    const e = document.createElement('span'); e.className = 'em'; e.textContent = em; row.appendChild(e);
    if (em === OWNER) {
      const t = document.createElement('span'); t.className = 'ownerTag'; t.textContent = '大元(管理者)'; row.appendChild(t);
    } else {
      const b = document.createElement('button'); b.className = 'rm'; b.textContent = '削除'; b.onclick = () => remove(em); row.appendChild(b);
    }
    listEl.appendChild(row);
  });
}

async function load() {
  const r = await fetch('/api/admin/allowlist');
  if (!r.ok) { setMsg('権限がありません', false); return; }
  const j = await r.json(); render(j.list, j.owner);
}

async function post(body) {
  const r = await fetch('/api/admin/allowlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { setMsg(j.error || '失敗しました', false); return false; }
  render(j.list, j.owner); return true;
}

async function add() {
  const inp = document.getElementById('addEmail'); const v = (inp.value || '').trim();
  if (!v) return;
  if (await post({ add: v })) { setMsg('追加しました', true); inp.value = ''; }
}

async function remove(em) {
  if (!confirm(em + ' を許可リストから削除しますか？')) return;
  if (await post({ remove: em })) setMsg('削除しました', true);
}

document.getElementById('btnAdd').addEventListener('click', add);
document.getElementById('addEmail').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
load();
