// pm2 の設定（本番サーバー）。deploy/deploy.sh が /opt/kametchi/current から起動する
module.exports = {
  apps: [
    {
      name: "kametchi",
      cwd: "/opt/kametchi/current",
      script: "dist/index.js",
      // .env は /opt/kametchi/shared/.env へのリンク
      node_args: "--env-file=.env",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      // ダジャレ判定の辞書（kuromoji）だけで約270MB 使う。メモリ 512MB のサーバーのため、
      // 上限を超えたら再起動する（仕様書 §8.2）
      max_memory_restart: "450M",
      // 停止時に配信から退室する時間を確保する
      kill_timeout: 10000,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
