import { describe, expect, it } from "vitest";
import { SseParser } from "../../src/spoon/sse.js";

describe("SseParser", () => {
  it("公式ドキュメントの chat イベントを解釈する", () => {
    const parser = new SseParser();
    const items = parser.feed(
      'id:1788407119681-0\nevent:chat\ndata:{"user":{"id":"a","nickname":"x"},"isDj":false}\n\n',
    );
    expect(items).toEqual([
      {
        type: "event",
        event: "chat",
        data: '{"user":{"id":"a","nickname":"x"},"isDj":false}',
        id: "1788407119681-0",
      },
    ]);
  });

  it("ハートビートのコメント行を返す", () => {
    expect(new SseParser().feed(":heartbeat\n\n")).toEqual([
      { type: "comment", text: "heartbeat" },
    ]);
  });

  it("チャンクの途中で切れた行を次のチャンクとつなげる", () => {
    const parser = new SseParser();
    expect(parser.feed("event: like\nda")).toEqual([]);
    expect(parser.feed('ta: {"a":1}\n')).toEqual([]);
    expect(parser.feed("\n")).toEqual([
      { type: "event", event: "like", data: '{"a":1}', id: undefined },
    ]);
  });

  it("CRLF と CR の改行を扱い、CRLF がチャンクをまたいでも1つの改行とみなす", () => {
    const parser = new SseParser();
    expect(parser.feed("event: end\r\ndata: x\r")).toEqual([]);
    expect(parser.feed("\n\r\n")).toEqual([
      { type: "event", event: "end", data: "x", id: undefined },
    ]);
    // 末尾の CR は次のチャンクを見るまで確定しない
    expect(parser.feed("data: y\r\r")).toEqual([]);
    expect(parser.feed("data: z\n\n")).toEqual([
      { type: "event", event: "message", data: "y", id: undefined },
      { type: "event", event: "message", data: "z", id: undefined },
    ]);
  });

  it("複数の data 行を改行でつなぐ", () => {
    expect(new SseParser().feed("data: a\ndata: b\n\n")).toEqual([
      { type: "event", event: "message", data: "a\nb", id: undefined },
    ]);
  });

  it("data がないブロックは通知せず、event 名を次に持ち越さない", () => {
    const parser = new SseParser();
    expect(parser.feed("event: chat\n\ndata: z\n\n")).toEqual([
      { type: "event", event: "message", data: "z", id: undefined },
    ]);
  });

  it("id は次のイベントにも引き継がれる", () => {
    const parser = new SseParser();
    const items = parser.feed("id: 1-0\ndata: a\n\ndata: b\n\n");
    expect(items.map((i) => (i.type === "event" ? i.id : null))).toEqual(["1-0", "1-0"]);
  });

  it("値の先頭の空白は1つだけ取り除く", () => {
    expect(new SseParser().feed("data:  two spaces\n\n")).toEqual([
      { type: "event", event: "message", data: " two spaces", id: undefined },
    ]);
  });

  it("未知のフィールドは無視する", () => {
    expect(new SseParser().feed("retry: 1000\nfoo: bar\ndata: ok\n\n")).toEqual([
      { type: "event", event: "message", data: "ok", id: undefined },
    ]);
  });
});
