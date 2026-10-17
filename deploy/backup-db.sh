#!/usr/bin/env bash
# データベースのバックアップ（DB サーバーの cron から毎日実行する）。
#
# バックアップには連携のトークン（暗号化済み）とダジャレ判定の対象の ID が含まれるため、
# 保持は7日分に限る（連携解除時の削除が、バックアップに長く残らないように）。
set -euo pipefail

# cron の PATH には /usr/sbin が入っておらず、runuser が見つからずに失敗していた（2026-10-16〜17）
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

DB=kametti
DIR=/var/backups/kametti
KEEP_DAYS=7

mkdir -p "$DIR"
chmod 700 "$DIR"
FILE="$DIR/$DB-$(date +%Y%m%d-%H%M%S).dump"

runuser -u postgres -- pg_dump --format=custom "$DB" >"$FILE.partial"
mv "$FILE.partial" "$FILE"
chmod 600 "$FILE"

find "$DIR" -name "$DB-*.dump" -type f -mtime +"$((KEEP_DAYS - 1))" -delete
find "$DIR" -name "*.partial" -type f -mmin +60 -delete
