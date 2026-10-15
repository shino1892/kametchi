import { html } from "hono/html";
import { APP_NAME, type Html, layout } from "./views.js";

/** 削除・除外の依頼を受ける窓口。.env で設定する */
export interface PrivacyContact {
  /** X のアカウント（例: @example） */
  x?: string;
  email?: string;
}

/** プライバシーポリシーの制定日・改定日。内容を変えたら更新する */
export const PRIVACY_POLICY_UPDATED = "2026年10月15日";

/**
 * プライバシーポリシー。誰でも見られる。
 * 内容は仕様書 §8・§9 と申請内容（docs/app-purpose.md）に一致させる。
 */
export function privacyPage(contact: PrivacyContact): Html {
  const xUrl = contact.x ? `https://x.com/${contact.x.replace(/^@/, "")}` : null;

  return layout(
    "プライバシーポリシー",
    html`<h1>プライバシーポリシー</h1>
      <p class="muted">${PRIVACY_POLICY_UPDATED} 制定</p>

      <section>
        <h2>このボットについて</h2>
        <p>${APP_NAME} は、特定の配信者1名の配信を盛り上げるための補助ボットです。Spoon公式の Spoon Developers API を使い、配信者がSpoonで許可した範囲の情報だけを扱います。操作できるのは、配信者本人と開発者の2名だけです。</p>
        <p>ボットが配信に参加していることは、Spoonが配信のチャットで自動的にお知らせします。ボットは、無料ハートまたは有料ハート1個が届いたときに決まった文面のお礼を送ります。また、配信者または開発者が Discord で書いた文章を、ボットの名前で配信のチャットに送ることがあります。</p>
      </section>

      <section>
        <h2>扱う情報</h2>
        <ul>
          <li>配信のチャット（送った人の識別子・ニックネーム・本文）: ボットの中で一時的に処理するだけで、保存しません</li>
          <li>ハートが届いたこと: お礼を送るきっかけに使うだけで、保存しません</li>
        </ul>
        <p>識別子は、Spoonが提供する、このボット専用の暗号化された値です。プロフィール画像は扱いません。</p>
      </section>

      <section>
        <h2>ダジャレ判定と Discord への投稿</h2>
        <p>あらかじめ本人の了承を得たリスナーのチャットだけを対象に、ダジャレらしい発言かどうかを判定します。ダジャレらしい発言は、その本文とニックネームを、配信者と開発者の2名だけが参加する非公開の Discord サーバーに投稿し、2名で投票します。</p>
        <ul>
          <li>投票で却下された投稿は、その時点で削除します</li>
          <li>それ以外の投稿は、配信者がこのボットとの連携を解除したときに、すべて削除します</li>
          <li>判定の対象者として、その人の識別子（上記の暗号化された値）を保存します</li>
        </ul>
      </section>

      <section>
        <h2>保存期間</h2>
        <ul>
          <li>判定の対象者の識別子、Discord に投稿したダジャレ: 連携の解除まで（本人の依頼があればその時点で削除）</li>
          <li>ボットの動作の記録（リスナーを特定する情報は含みません）: 30日</li>
        </ul>
        <p>チャットの本文、イベントの原文、リスナーの活動の記録は、ボットのデータベースに保存しません。期間を過ぎた情報は、復元できない方法で削除します。</p>
      </section>

      <section>
        <h2>判定から外してほしい・投稿を消してほしいとき</h2>
        <p>次のいずれかでご連絡ください。ご依頼を受けたら、あなたの投稿と識別子を削除し、以後は判定しません。</p>
        <ul>
          <li>配信中のチャット、またはSpoonのメッセージで配信者に直接</li>
          ${contact.x && xUrl ? html`<li>X（旧Twitter）: <a href="${xUrl}" rel="noopener noreferrer">${contact.x}</a> へのダイレクトメッセージ</li>` : ""}
          ${contact.email ? html`<li>メール: <a href="mailto:${contact.email}">${contact.email}</a></li>` : ""}
        </ul>
      </section>

      <section>
        <h2>情報の管理</h2>
        <p>情報は開発者が管理するサーバーに保存し、通信は暗号化します。Spoonとの連携に使う認証情報も暗号化して保存します。</p>
      </section>`,
  );
}
