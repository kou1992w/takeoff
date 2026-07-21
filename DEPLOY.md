# takeoff デプロイ手順(GCP 無料VM + Caddy + rclone)

前提: GCP無料VM(e2-micro/Ubuntu22.04)、静的IP、`a1-takeoff.duckdns.org` がそのIPを指す、OAuthクライアント発行済み。

## A. アプリを動かす(ログイン+HTTPS)
VMのSSH(ブラウザSSH可)で:

```bash
sudo apt-get install -y git
git clone https://github.com/kou1992w/takeoff.git
cd takeoff
bash setup.sh
nano .env   # ALLOWLIST / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を記入して保存
sudo systemctl restart takeoff
```
→ ブラウザで https://a1-takeoff.duckdns.org を開き、Googleログインできるか確認(現場一覧はまだ空)。

## B. Drive接続(サービスアカウント)
1. GCP: 「APIとサービス → ライブラリ」で **Google Drive API** を有効化
2. 「IAMと管理 → サービスアカウント」で作成 → キー(JSON)を作成しダウンロード
3. サービスアカウントのメール(`xxx@takeoff-...iam.gserviceaccount.com`)を控える
4. Googleドライブで「A1現場情報」フォルダを、そのSAメールに**閲覧者**で共有
5. そのフォルダのURL `drive.google.com/drive/folders/<ID>` の `<ID>` を控える
6. VMにキーJSONを置く(例: `~/takeoff-sa.json`)
7. rclone リモート作成:
```bash
rclone config create gdrive drive scope=drive.readonly \
  service_account_file=$HOME/takeoff-sa.json root_folder_id=<ID>
rclone lsjson gdrive: -R --files-only | head   # 配置図が見えるか確認
sudo systemctl restart takeoff
```
→ 現場一覧が出れば完了。

## 運用
- ログ: `journalctl -u takeoff -f`
- コード更新: `cd ~/takeoff && git pull && sudo systemctl restart takeoff`
- 再スキャン: アプリ内「Driveを再スキャン」ボタン(または `/api/rescan`)

## 作図データの保護（2026-07-21）
サーバー再起動中にアプリのタブが `/api/load` に失敗すると、空の状態のまま編集画面に入り、
その後の自動保存で保存済みの作図が空データで上書きされる事故が起きた（東根市神町東 第5）。対策:

- `/api/save`: 保存済みが非空で、**自動保存**が空 → 409で拒否（手動保存＝全消しの意思表示は通す）
- 上書き前に `saves/backup/<hash>_<epoch>.json` へ退避（現場ごと直近10世代）
- クライアント: 配置図/保存データの読み込みに失敗したら編集画面に入らず現場一覧へ戻す

**更新時の注意**: `sudo systemctl restart takeoff` は誰かが編集中だと一時的に通信が切れる。作業時間帯を避けるのが望ましい。
