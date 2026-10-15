/**
 * Server-Sent Events の行パーサー（WHATWG HTML の Event stream 解釈に準拠）。
 *
 * ブラウザの EventSource は Authorization ヘッダーを付けられないため、
 * fetch で受け取った本文をこのパーサーで解釈する（仕様書 §5.1）。
 */

export type SseItem =
  | { type: "event"; event: string; data: string; id: string | undefined }
  /** `:` で始まるコメント行。Spoon は15秒ごとのハートビートに使う */
  | { type: "comment"; text: string };

export class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private lastEventId: string | undefined;
  private hasData = false;

  /** 受信したテキストを追加し、完成した項目を返す。行の途中で切れた分は次回に持ち越す */
  feed(chunk: string): SseItem[] {
    this.buffer += chunk;
    const items: SseItem[] = [];

    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // 末尾の \r は次のチャンクの \n と組になる可能性があるため、確定を待つ
      if (match[0] === "\r" && match.index === this.buffer.length - 1) break;

      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const item = this.processLine(line);
      if (item) items.push(item);
    }
    return items;
  }

  private processLine(line: string): SseItem | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return { type: "comment", text: line.slice(1).trimStart() };

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      // retry などは使わない
    }
    return null;
  }

  private dispatch(): SseItem | null {
    const item: SseItem | null = this.hasData
      ? {
          type: "event",
          event: this.eventName || "message",
          data: this.dataLines.join("\n"),
          id: this.lastEventId,
        }
      : null;
    this.eventName = "";
    this.dataLines = [];
    this.hasData = false;
    return item;
  }
}
