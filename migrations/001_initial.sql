-- 初期スキーマ（仕様書 §9.1）
-- Spoon連携は1件だけ。連携の削除で、配下の設定・判定対象・ダジャレ投稿の記録をすべて削除する。
-- チャット本文、イベントの原文、リスナーのニックネームは保存しない（§9.2）。

-- Spoon連携（§5）。singleton で1行に限る
CREATE TABLE spoon_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  -- トークンは AES-256-GCM で暗号化し、行の id に結びつけて保存する
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 連携用の招待（/link）。トークンは SHA-256 のハッシュだけを保存する。10分で失効し、1回だけ使える
CREATE TABLE link_invites (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX link_invites_expires_at_idx ON link_invites (expires_at);

-- OAuth の state。招待とブラウザ（Cookie の値のハッシュ）に結びつける。使用後すぐに削除する
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  invite_hash text NOT NULL REFERENCES link_invites (token_hash) ON DELETE CASCADE,
  browser_hash text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX oauth_states_expires_at_idx ON oauth_states (expires_at);

-- 設定（§7.4）。行がなければ既定値（ハートコメントはオン）
CREATE TABLE settings (
  connection_id uuid PRIMARY KEY REFERENCES spoon_connection (id) ON DELETE CASCADE,
  heart_comment boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ダジャレ判定の対象（§8.1）。本人の了承を得たリスナーの user.id と、Discord で入力したメモだけ
CREATE TABLE dajare_targets (
  connection_id uuid NOT NULL REFERENCES spoon_connection (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  memo text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, user_id)
);

-- Discord に投稿したダジャレ（§8.3）。連携解除時に Discord から削除するための ID と投票の状態だけ。
-- 本文・ニックネーム・user.id は保存しない
CREATE TABLE dajare_posts (
  message_id text PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES spoon_connection (id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  status text NOT NULL DEFAULT 'voting' CHECK (status IN ('voting', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dajare_posts_connection_idx ON dajare_posts (connection_id);

-- 動作の記録。リスナーを特定する情報・チャット本文・トークンは含めない。30日で削除する
CREATE TABLE app_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_logs_created_at_idx ON app_logs (created_at);
