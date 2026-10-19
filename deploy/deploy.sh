#!/usr/bin/env bash
# 本番サーバーへデプロイする（手元の Git Bash から実行）。
#
#   deploy/deploy.sh
#
# コミット済みの内容を手元でテスト・ビルドし、サーバーの
# /opt/kametchi/releases/<コミット> に配置して current を切り替える。
# サーバーのメモリが少ないため、ビルドは手元で行い、サーバーでは本番用の依存だけを入れる。
set -euo pipefail

HOST="${DEPLOY_HOST:-192.168.0.111}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/kametchi-server_ed25519}"
APP_DIR=/opt/kametchi
PORT=8790
KEEP_RELEASES=3
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "root@$HOST")

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "コミットしていない変更があります。コミットしてからデプロイしてください。" >&2
  exit 1
fi
REV="$(git rev-parse --short HEAD)"
echo "==> $REV をテスト・ビルドします"
pnpm install --frozen-lockfile
pnpm check
pnpm test
rm -rf dist
pnpm build

ARCHIVE="$(mktemp -t kametchi-XXXXXX.tgz)"
trap 'rm -f "$ARCHIVE"' EXIT
tar -czf "$ARCHIVE" --owner=0 --group=0 dist migrations package.json pnpm-lock.yaml deploy/ecosystem.config.cjs

echo "==> $HOST に送ります"
scp -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -q "$ARCHIVE" "root@$HOST:/tmp/kametchi-$REV.tgz"

"${SSH[@]}" bash -s -- "$REV" "$APP_DIR" "$KEEP_RELEASES" "$PORT" <<'REMOTE'
set -euo pipefail
REV="$1"; APP_DIR="$2"; KEEP="$3"; PORT="$4"
RELEASE="$APP_DIR/releases/$REV"

test -f "$APP_DIR/shared/.env" || { echo "$APP_DIR/shared/.env がありません" >&2; exit 1; }

rm -rf "$RELEASE"
mkdir -p "$RELEASE"
# 手元（Windows）のファイル所有者は引き継がない
tar -xzf "/tmp/kametchi-$REV.tgz" -C "$RELEASE" --no-same-owner
rm -f "/tmp/kametchi-$REV.tgz"
ln -sfn "$APP_DIR/shared/.env" "$RELEASE/.env"

cd "$RELEASE"
pnpm install --prod --frozen-lockfile --silent

ln -sfn "$RELEASE" "$APP_DIR/current"
# 停止すると配信から退室する（再起動後は退室した状態から始まる）
pm2 delete kametchi >/dev/null 2>&1 || true
pm2 start "$APP_DIR/current/deploy/ecosystem.config.cjs"
pm2 save >/dev/null

# 起動を確認する（Discord へのログインと辞書の読み込みを待つ）
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "==> $REV を起動しました（/healthz OK）"
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { echo "起動を確認できませんでした: pm2 logs kametchi" >&2; exit 1; }

# 古いリリースを消す（直近 KEEP 個を残す）
cd "$APP_DIR/releases"
ls -1t | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
REMOTE
