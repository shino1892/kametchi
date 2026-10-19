import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export const APP_NAME = "kametchi";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export function layout(title: string, body: Html): Html {
  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${title} | ${APP_NAME}</title>
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    <header><span class="brand">${APP_NAME}</span></header>
    <main>${body}</main>
    <footer><a href="/privacy">プライバシーポリシー</a></footer>
  </body>
</html>`;
}

/** 招待 URL を開いたときの案内（仕様書 §5.1 の 2）。ボタンを押すまで招待は使わない */
export function linkStartPage(token: string): Html {
  return layout(
    "Spoonと連携する",
    html`<h1>Spoonと連携する</h1>
      <p>kametchi のボットが、あなたの配信でハートのお礼を送ったり、Discord からのコメントを届けたりできるように、Spoon との連携をお願いします。</p>
      <ul>
        <li><strong>DJ 本人の Spoon アカウント</strong>で同意してください。</li>
        <li>このブラウザでボットのアカウントのまま Spoon Developers にログインしている場合は、シークレットウィンドウでこのページを開き直してください（ボットのアカウントでは連携できません）。</li>
        <li>この URL は10分間・1回だけ使えます。ほかの人には見せないでください。</li>
      </ul>
      <form method="post" action="/link/${token}">
        <button type="submit">Spoonと連携する</button>
      </form>
      <p class="muted">次の画面で、Spoon が許可する内容（配信の確認、チャット・ハートの受信、チャットの送信）を表示します。</p>`,
  );
}

export function messagePage(title: string, lines: string[]): Html {
  return layout(title, html`<h1>${title}</h1>${lines.map((line) => html`<p>${line}</p>`)}`);
}

/**
 * Spoon の同意画面へ移るページ。フォームの応答から直接リダイレクトすると、ブラウザが
 * CSP の form-action でログイン画面（別のサイト）への移動を止めるため、ここから改めて移動する
 */
export function goToSpoonPage(authorizeUrl: string): Html {
  return html`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta http-equiv="refresh" content="0;url=${authorizeUrl}" />
    <title>Spoon に移動します | ${APP_NAME}</title>
    <link rel="stylesheet" href="/static/app.css" />
  </head>
  <body>
    <header><span class="brand">${APP_NAME}</span></header>
    <main>
      <h1>Spoon に移動します</h1>
      <p>自動で移動しない場合は、次のボタンを押してください。</p>
      <p><a class="button" href="${authorizeUrl}">Spoon のログイン画面へ進む</a></p>
      <p class="muted">この画面は10分以内に進めてください。</p>
    </main>
  </body>
</html>`;
}

export const invalidInvitePage = () =>
  messagePage("この URL は使えません", [
    "期限（10分）が切れたか、すでに使われた URL です。",
    "Discord で /link を実行して、新しい URL を発行してもらってください。",
  ]);

export const STYLESHEET = `
:root { color-scheme: light dark; --accent: #e8590c; --muted: #868e96; --line: color-mix(in srgb, currentColor 15%, transparent); }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.7; }
header { padding: 12px 16px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; }
main { max-width: 720px; margin: 0 auto; padding: 16px; }
section { margin: 24px 0; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.15rem; }
button, .button { display: inline-block; text-decoration: none; padding: 10px 20px; border: 0; border-radius: 6px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
form { margin: 16px 0; }
.muted { color: var(--muted); font-size: 0.9em; }
footer { max-width: 720px; margin: 32px auto 0; padding: 16px; border-top: 1px solid var(--line); font-size: 0.9em; }
footer a { color: var(--muted); }
`;
