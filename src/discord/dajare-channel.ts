import {
  type Client,
  EmbedBuilder,
  Events,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import {
  APPROVE_EMOJI,
  type DajareMessageHandle,
  type DajareVoting,
  REJECT_EMOJI,
} from "../dajare/voting.js";

const CANDIDATE_COLOR = 0x00ae86;
const APPROVED_COLOR = 0xffd700;
const CANDIDATE_SUFFIX = "のダジャレ候補";

/**
 * Discord のダジャレチャンネル（仕様書 §8.3）。旧 kametti と同じ見た目で候補を投稿し、
 * リアクションと削除を DajareVoting に渡す。プロフィール画像は公式 API にないため付けない。
 */
export class DajareChannel {
  constructor(
    private readonly client: Client,
    private readonly channelId: string,
    private readonly voting: Pick<DajareVoting, "onReaction" | "onMessageDeleted">,
    private readonly onError: (error: unknown, context: string) => void,
  ) {
    client.on(Events.MessageReactionAdd, (reaction, user) => void this.onReaction(reaction, user));
    client.on(Events.MessageDelete, (message) => void this.onDelete(message));
  }

  /** ダジャレ候補を投稿し、⭕ と ❌ を付ける */
  async post(nickname: string, text: string): Promise<{ channelId: string; messageId: string }> {
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel?.isSendable()) throw new Error("dajare channel is not sendable");
    const embed = new EmbedBuilder()
      .setColor(CANDIDATE_COLOR)
      .setAuthor({ name: `${nickname}${CANDIDATE_SUFFIX}` })
      .setTitle(text)
      .addFields({ name: "📊 状況", value: "投票受付中", inline: true })
      .setTimestamp();
    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    await message.react(APPROVE_EMOJI);
    await message.react(REJECT_EMOJI);
    return { channelId: message.channelId, messageId: message.id };
  }

  private async onReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot || reaction.message.channelId !== this.channelId) return;
    const emoji = reaction.emoji.name;
    if (!emoji) return;
    try {
      await this.voting.onReaction(reaction.message.id, emoji, async () =>
        handleOf(await reaction.message.fetch()),
      );
    } catch (error) {
      this.onError(error, "dajare vote failed");
    }
  }

  private async onDelete(message: Message | PartialMessage): Promise<void> {
    if (message.channelId !== this.channelId) return;
    try {
      await this.voting.onMessageDeleted(message.id);
    } catch (error) {
      this.onError(error, "failed to forget deleted dajare post");
    }
  }
}

function handleOf(message: Message): DajareMessageHandle {
  return {
    countVotes: async (emoji) => {
      const reaction = message.reactions.cache.get(emoji);
      if (!reaction) return 0;
      // ボット自身が付けた分を除く
      return reaction.count - (reaction.me ? 1 : 0);
    },
    markApproved: async () => {
      const original = message.embeds[0];
      const author = original?.author?.name ?? "";
      const nickname = author.endsWith(CANDIDATE_SUFFIX)
        ? author.slice(0, -CANDIDATE_SUFFIX.length)
        : author;
      const approved = new EmbedBuilder()
        .setColor(APPROVED_COLOR)
        .setAuthor({ name: "🏆 公認ダジャレ！" })
        .setTitle(original?.title ?? "")
        .addFields({ name: "投稿者", value: nickname || "リスナー", inline: true })
        .setFooter({ text: "kametchi Dajare System" })
        .setTimestamp();
      await message.edit({ embeds: [approved] });
    },
    delete: async () => {
      await message.delete();
    },
  };
}
