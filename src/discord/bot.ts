import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  type Interaction,
  InteractionContextType,
  MessageFlags,
  REST,
  RESTJSONErrorCodes,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import type { Config } from "../config.js";
import type {
  BotReply,
  ButtonInteractionLike,
  ButtonSpec,
  CommandInteractionLike,
  ReplyOptions,
} from "./interactions.js";

/** スラッシュコマンドの定義。DISCORD_GUILD_ID のサーバーにだけ登録する（仕様書 §5.3） */
export const COMMANDS = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("推しに Spoon と連携してもらうための URL を発行する（10分間・1回だけ有効）")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Spoon との連携を解除する（確認が出ます）")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("推しの配信にボットを参加させる")
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("ボットを推しの配信から退室させる")
    .setContexts(InteractionContextType.Guild),
];

export type CommandHandler = (interaction: CommandInteractionLike) => Promise<void>;
/** 自分のボタンなら処理して true を返す */
export type ButtonHandler = (interaction: ButtonInteractionLike) => Promise<boolean>;

export interface DiscordBotOptions {
  discord: Config["discord"];
  onError?: (error: unknown, context: string) => void;
  onReady?: (tag: string) => void;
}

/**
 * Discord ボット。スラッシュコマンドとボタンを各機能の処理に振り分け、
 * メインチャンネルへの通知とメッセージの削除を提供する。
 */
export class DiscordBot {
  readonly client: Client;
  private readonly commands = new Map<string, CommandHandler>();
  private readonly buttons: ButtonHandler[] = [];

  constructor(private readonly options: DiscordBotOptions) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
    this.client.on(Events.InteractionCreate, (interaction) => void this.dispatch(interaction));
    this.client.on(Events.Error, (error) => options.onError?.(error, "discord client error"));
  }

  onCommand(name: string, handler: CommandHandler): void {
    this.commands.set(name, handler);
  }

  onButton(handler: ButtonHandler): void {
    this.buttons.push(handler);
  }

  /** ログインし、スラッシュコマンドを登録する */
  async start(): Promise<void> {
    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, (client) => {
        this.options.onReady?.(client.user.tag);
        resolve();
      });
    });
    await this.client.login(this.options.discord.botToken);
    await ready;
    const rest = new REST({ version: "10" }).setToken(this.options.discord.botToken);
    await rest.put(
      Routes.applicationGuildCommands(this.options.discord.appId, this.options.discord.guildId),
      { body: COMMANDS.map((command) => command.toJSON()) },
    );
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /** メインチャンネルに通知する。メンションで通知音を鳴らさない */
  async notify(message: string | BotReply): Promise<void> {
    const reply = typeof message === "string" ? { content: message } : message;
    const channel = await this.client.channels.fetch(this.options.discord.mainChannelId);
    if (!channel?.isSendable()) throw new Error("main channel is not sendable");
    await channel.send(toPayload(reply));
  }

  /** メッセージを削除する。すでにない（削除済み・チャンネルがない）場合は成功とみなす */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      await channel.messages.delete(messageId);
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        (error.code === RESTJSONErrorCodes.UnknownMessage ||
          error.code === RESTJSONErrorCodes.UnknownChannel)
      ) {
        return;
      }
      throw error;
    }
  }

  private async dispatch(interaction: Interaction): Promise<void> {
    // 決めたサーバーの中の操作だけを受け付ける
    if (interaction.guildId !== this.options.discord.guildId) return;
    try {
      if (interaction.isChatInputCommand()) {
        const handler = this.commands.get(interaction.commandName);
        if (handler) await handler(wrapCommand(interaction));
      } else if (interaction.isButton()) {
        const wrapped = wrapButton(interaction);
        for (const handler of this.buttons) {
          if (await handler(wrapped)) break;
        }
      }
    } catch (error) {
      this.options.onError?.(error, "discord interaction failed");
      if (interaction.isRepliable()) {
        const payload = {
          content: "⚠️ エラーが発生しました。時間をおいてやり直してください。",
          flags: MessageFlags.Ephemeral,
        } as const;
        const send =
          interaction.replied || interaction.deferred
            ? interaction.followUp(payload)
            : interaction.reply(payload);
        await send.catch(() => {});
      }
    }
  }
}

function wrapCommand(interaction: ChatInputCommandInteraction): CommandInteractionLike {
  return {
    userId: interaction.user.id,
    reply: async (reply) => {
      await interaction.reply(toReplyPayload(reply));
    },
    deferReply: async () => {
      await interaction.deferReply();
    },
    editReply: async (reply) => {
      await interaction.editReply(toPayload(reply));
    },
  };
}

function wrapButton(interaction: ButtonInteraction): ButtonInteractionLike {
  return {
    userId: interaction.user.id,
    customId: interaction.customId,
    update: async (reply) => {
      await interaction.update(toPayload(reply));
    },
    reply: async (reply) => {
      await interaction.reply(toReplyPayload(reply));
    },
    deferUpdate: async () => {
      await interaction.deferUpdate();
    },
    deferReply: async () => {
      await interaction.deferReply();
    },
    editReply: async (reply) => {
      await interaction.editReply(toPayload(reply));
    },
  };
}

function toReplyPayload(reply: ReplyOptions) {
  return {
    ...toPayload(reply),
    ...(reply.ephemeral ? { flags: MessageFlags.Ephemeral as const } : {}),
  };
}

export function toPayload(reply: BotReply) {
  return {
    content: reply.content,
    allowedMentions: { parse: [] },
    ...(reply.buttons
      ? { components: reply.buttons.length > 0 ? [buttonRow(reply.buttons)] : [] }
      : {}),
  };
}

const STYLES: Record<ButtonSpec["style"], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger: ButtonStyle.Danger,
};

function buttonRow(buttons: ButtonSpec[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((spec) => {
      const button = new ButtonBuilder()
        .setCustomId(spec.customId)
        .setLabel(spec.label)
        .setStyle(STYLES[spec.style]);
      if (spec.emoji) button.setEmoji(spec.emoji);
      return button;
    }),
  );
}
