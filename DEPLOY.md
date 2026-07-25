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

## C. 表示する現場を工程表スプレッドシートで絞る（2026-07-25）
一覧に出す現場を、会社の現場管理スプレッドシート「現場コード」列に載っている現場だけに限定する仕組み。
突き合わせは現場コード6桁（配置図ファイル名の管理番号先頭6桁）。DriveとシートのどちらにもあるものだけAND表示。

必要な設定は**1回だけ**:
1. Driveで使っているサービスアカウントのメール（`xxx@...iam.gserviceaccount.com`）に、
   対象スプレッドシートを「**閲覧者**」で共有する。← これだけ
2. `sudo systemctl restart takeoff`（または「Driveを再スキャン」ボタン）で反映。

- 対象シートは既定でコードに埋め込み済み（`SHEET_ID` / `SHEET_GID`）。別シートにするなら `.env` で上書き。
- SA鍵は `rclone.conf` の `service_account_file` を自動流用（`SA_KEY_FILE` で明示指定も可）。
- 認証: SAのJWT→アクセストークン→シートをCSVエクスポート取得（追加のAPI有効化・依存ライブラリ不要。Drive APIのみでOK）。
- **フェイルオープン**: 未共有・取得失敗時は絞り込まず全件表示（アプリが空になるのを防ぐ）。前回取得分は `allow-codes.json` に保存。
- 同一タブ内の下段「図面同期ログ」表は空行区切りの手前で止めて拾わない（先頭の現場管理表のみ対象）。
- シート更新の反映: 毎日JST0時の再スキャン、または「Driveを再スキャン」ボタン/`/api/rescan`。

## D. 仮図でも外構図を作成（2026-07-25）
配置図(原図)のUPが遅い急ぎ現場向けに、**仮図(1PDFに複数図が入る)でも台紙にできる**オプション機能。基本は配置図。

- スキャン: 同じ号棟フォルダの `(仮図)*.pdf` も収集（`fileKind()`）。**配置図が無く仮図だけの現場も一覧に出る**（従来は出なかった）。
- 保存キー: 配置図の先頭のみ現場キー（既存保存と互換）。仮図は必ず `現場キー#pid`＝配置図の保存と混ざらない。作図データは配置図/仮図で別。
- 一覧: 号棟単位で表示。仮図のみの現場は「仮」タグ。配置図＋仮図がある号棟は「図面を選ぶ ▾」で切替（既定は配置図）。
- 仮図を開くと**配置図ページを自動推定→サムネイルで確認/修正**（下部のページ確認UI）。選んだページは保存に記録し次回復元。
- 縮尺: 「配置図 S:1/100」等、配置図タイトルに紐づく縮尺を優先取得（付近見取図1/1500・平面図1/75等の誤検出を回避）。外れたら1/100・1/150手動ボタン。
- 費用管理: 号棟ごとに1図面だけ集計（配置図優先、無ければ仮図）＝二重計上しない。
- **注意**: 仮図で作図後に配置図が届いても台紙の座標系が別なので作図は移らない（仮図分は仮図のまま。配置図で作り直し）。

## 運用
- ログ: `journalctl -u takeoff -f`
- コード更新: `cd ~/takeoff && git pull && sudo systemctl restart takeoff`
- 再スキャン: アプリ内「Driveを再スキャン」ボタン(または `/api/rescan`) ← 現場フォルダ再スキャン＋シート再取得

## 作図データの保護（2026-07-21）
サーバー再起動中にアプリのタブが `/api/load` に失敗すると、空の状態のまま編集画面に入り、
その後の自動保存で保存済みの作図が空データで上書きされる事故が起きた（東根市神町東 第5）。対策:

- `/api/save`: 保存済みが非空で、**自動保存**が空 → 409で拒否（手動保存＝全消しの意思表示は通す）
- 上書き前に `saves/backup/<hash>_<epoch>.json` へ退避（現場ごと直近10世代）
- クライアント: 配置図/保存データの読み込みに失敗したら編集画面に入らず現場一覧へ戻す

**更新時の注意**: `sudo systemctl restart takeoff` は誰かが編集中だと一時的に通信が切れる。作業時間帯を避けるのが望ましい。
