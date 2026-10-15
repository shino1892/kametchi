# kametti 運用手順書

本番環境の構成、デプロイ、バックアップ、障害時の対応をまとめる。設計は [仕様書](spec.md) を参照。

## 1. 構成

```text
[推しのブラウザ] --https--> [Nginx Proxy Manager 192.168.0.100] --http:8790--> [kametti 192.168.0.111]
                             kametchi.com（Let's Encrypt）                        pm2: kametti
                                                                                  |  |
[Discord] <------------------------------------------------- discord.js -------+  |
                                                 PostgreSQL 17 <------------------+  (SSL)
                                                 192.168.0.109 / DB: kametti
[kametti] --https--> Spoon Developers API（jp-openapi.spooncast.net）
```

| 項目 | 値 |
| ---- | -- |
| URL | https://kametchi.com（連携用ページ、`/privacy`、`/healthz` だけ） |
| アプリサーバー | 192.168.0.111（Ubuntu 24.04 LXC、メモリ 512MB、スワップ 512MB）、root、鍵 `~/.ssh/kametti-server_ed25519` |
| DB サーバー | 192.168.0.109（PostgreSQL 17、Lens と共用）、root、鍵 `~/.ssh/spoon-db-server_ed25519` |
| 配置 | `/opt/kametti/releases/<コミット>`、`current` が使用中の版へのリンク |
| 設定 | `/opt/kametti/shared/.env`（権限 600。各リリースからリンク） |
| プロセス | pm2 の `kametti`（OS 起動時に `pm2-root.service` が復元）。メモリが 450MB を超えたら再起動 |
| ファイアウォール | アプリサーバーの nftables で、8790 番は NPM（192.168.0.100）とサーバー内からだけ受ける（`/etc/nftables.conf`。元の設定は `/etc/nftables.conf.orig`） |
| DB | ロール・DB とも `kametti`。ほかのユーザーは接続できない（`REVOKE CONNECT ... FROM PUBLIC`） |
| バックアップ | DB サーバーで毎日 4:45 に `pg_dump`（`/usr/local/sbin/kametti-backup`、`/etc/cron.d/kametti-backup`）、`/var/backups/kametti` に7日分 |

DB サーバーには Listener Lens（`listener_lens`）とほかのプロジェクトの DB（`lastkadai`、`sanda_bot`、`syuwa_ti`）、ロール `spoon_user` がある。kametti の作業ではこれらに触れない。Lens のアプリサーバー（192.168.0.108）にも触れない。

## 2. 最初の準備（済み）

| 作業 | 内容 |
| ---- | ---- |
| SSH の鍵 | `~/.ssh/kametti-server_ed25519` を作り、アプリサーバーの root に登録した |
| Node | NodeSource の `node_22.x` に切り替えて Node 22 にした。pnpm・pm2 は npm のグローバル |
| 旧 kametti | pm2 から外し、`/opt/kametti-monitor` を削除した |
| DB | `CREATE ROLE kametti LOGIN PASSWORD ...`、`CREATE DATABASE kametti OWNER kametti`、`REVOKE CONNECT ON DATABASE kametti FROM PUBLIC` |
| 設定 | `/opt/kametti/shared/.env` を作った（DB のパスワードと暗号化鍵は生成した値。Discord の値は旧 kametti と同じ） |
| ファイアウォール・自動起動 | nftables の設定、`pm2 startup systemd` |

### ユーザーの作業

| 作業 | 内容 |
| ---- | ---- |
| DNS | `kametchi.com` を自宅のグローバル IP に向ける。ルーターで 80・443 を NPM（192.168.0.100）へ転送する（Lens と同じ） |
| NPM | プロキシホスト `kametchi.com` → `http://192.168.0.111:8790`、Let's Encrypt の証明書、HTTPS を強制 |
| Spoon Developers | 旧 kametti の Spoon アカウントでアプリを登録する（[app-purpose.md](app-purpose.md)）。承認されたら `SPOON_CLIENT_ID`・`SPOON_CLIENT_SECRET` を `.env` に入れる（§4） |
| Discord Developer Portal | ボットの Message Content Intent をオンにする（Bot → Privileged Gateway Intents） |

## 3. デプロイ

手元の Git Bash で、コミットしてから実行する。

```sh
deploy/deploy.sh
```

1. 手元でテスト・型チェック・ビルドする（サーバーはメモリが少ないためビルドしない）
2. `dist`・`migrations`・`package.json`・`pnpm-lock.yaml` をサーバーに送り、`releases/<コミット>` に展開する
3. 本番用の依存だけを入れ、`current` を切り替えて pm2 で起動し直す。**参加中の配信からは退室する**（再起動後は退室した状態から始まるため、配信中なら `/join` し直す）
4. `/healthz` で起動を確認し、直近3リリースより古いものを消す

マイグレーションは起動時に自動で適用される。スラッシュコマンドも起動時に登録し直す。

### 前の版に戻す

```sh
ssh -i ~/.ssh/kametti-server_ed25519 root@192.168.0.111
cd /opt/kametti && ls -1t releases          # 戻したい版を選ぶ
ln -sfn /opt/kametti/releases/<コミット> current
pm2 delete kametti && pm2 start current/deploy/ecosystem.config.cjs && pm2 save
```

## 4. 設定と鍵

`/opt/kametti/shared/.env` を編集したら、`pm2 restart kametti --update-env` で反映する。各項目は `.env.example` を参照。値を画面に出さないよう、編集はサーバー上のエディタで行う。

| 項目 | 注意 |
| ---- | ---- |
| `SPOON_CLIENT_ID`・`SPOON_CLIENT_SECRET` | 運用承認までは `PENDING_APPROVAL`。この間は Spoon に一切つながない（連携していないため、配信の確認も行わない）。`/link` は使わない |
| `TOKEN_ENCRYPTION_KEY` | 変えると保存済みのトークンを復号できなくなり、Spoon連携をやり直す必要がある |
| `SPOON_CLIENT_SECRET` | 漏洩したら Spoon Developers のコンソールで「再発行」し、`.env` を更新する |
| `DISCORD_BOT_TOKEN` | 漏洩したら Discord Developer Portal で Reset Token し、`.env` を更新する |
| `DATABASE_URL` | パスワードを変える場合は DB サーバーで `ALTER ROLE kametti PASSWORD '...'` と同時に更新する |
| `PRIVACY_CONTACT_X`・`PRIVACY_CONTACT_EMAIL` | `/privacy` に載せる窓口（どちらか必須） |

`.env` や鍵をリポジトリ、チャット、ログ、Discord に貼らない。

## 5. 日常の確認

```sh
ssh -i ~/.ssh/kametti-server_ed25519 root@192.168.0.111
pm2 ls                                   # 状態・メモリ・再起動回数
pm2 logs kametti --lines 100             # ログ（チャット本文・トークンは出さない）
curl -s http://127.0.0.1:8790/healthz    # ok
```

## 6. バックアップと復元

バックアップには連携のトークン（暗号化済み）とダジャレ判定の対象の ID が含まれるため、7日分だけ残す。手元や別の場所にコピーして長く残さない。

```sh
ssh -i ~/.ssh/spoon-db-server_ed25519 root@192.168.0.109
ls -la /var/backups/kametti/
/usr/local/sbin/kametti-backup           # 手動で取る
```

復元する場合（アプリを止めてから行う）:

```sh
# アプリサーバーで
pm2 stop kametti
# DB サーバーで
runuser -u postgres -- pg_restore --clean --if-exists -d kametti /var/backups/kametti/<ファイル>.dump
# アプリサーバーで
pm2 start kametti
```

## 7. 障害時の対応

| 症状 | 確認すること・対応 |
| ---- | ------------------ |
| 起動しない | `pm2 logs kametti`。`invalid configuration` なら `.env` の項目（値は出さずにキー名で確認）。DB に接続できるか |
| 連携用ページが開けない | `curl http://127.0.0.1:8790/healthz`。NPM のプロキシホストと証明書。nftables の設定 |
| Discord のコマンドが出ない | 起動時の登録の失敗（ログの `discord`）。`DISCORD_APP_ID`・`DISCORD_GUILD_ID` |
| チャットチャンネルの投稿が送られない | Message Content Intent がオンか。ボットが配信に参加しているか（⚠️ の返信の理由） |
| 「別の場所から接続されたため退室しました」 | 同じ連携で2つのプロセスが動いていないか（手元の `pnpm dev` を本番の連携で動かしていないか）。`pm2 ls` |
| メモリによる再起動が続く | `pm2 ls` の再起動回数とメモリ。コンテナのメモリを 1GB に増やす（Proxmox の画面から） |
| Spoon 側で連携が解除された | Discord に通知が出て、データは削除済み。`/link` で連携し直す |

## 8. 利用をやめるとき

1. Discord で `/unlink` を実行する（トークンの無効化、ダジャレの投稿と DB のデータの削除）
2. `pm2 delete kametti && pm2 save`
3. DB サーバーで `DROP DATABASE kametti; DROP ROLE kametti;`、`/etc/cron.d/kametti-backup` と `/var/backups/kametti` を削除する
4. Spoon Developers でアプリを削除する
