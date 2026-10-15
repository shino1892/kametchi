import { beforeAll, describe, expect, it } from "vitest";
import {
  buildTokenizer,
  DajareJudge,
  isDajareReading,
  normalizeReading,
  type Tokenizer,
  toReading,
} from "../../src/dajare/shareka.js";
import { LegacyShareka } from "./fixtures/legacy-shareka.js";

/** 旧版と比べる文。ダジャレ・ダジャレでない文・記号・絵文字・英数字・短い文・空を混ぜる */
const SENTENCES = [
  "布団が吹っ飛んだ",
  "アルミ缶の上にあるミカン",
  "猫が寝込んだ",
  "トイレにいっといれ",
  "カエルが帰る",
  "イクラはいくら？",
  "内容がないよう",
  "コーディネートはこーでねーと",
  "電話に誰も出んわ",
  "ダジャレを言うのは誰じゃ",
  "こんにちは",
  "今日もお疲れさまでした！",
  "配信ありがとう〜また来るね",
  "おはようございます。今日は雨ですね。",
  "うんうん",
  "ははははは",
  "ｗｗｗｗ",
  "わかる〜〜〜〜",
  "「すもももももももものうち」",
  "隣の客はよく柿食う客だ",
  "🍊🍊🍊みかん",
  "ok",
  "Hello world!!",
  "１２３４５",
  "あ",
  "",
  "　",
  "ショッピングでシャッフル",
  "チョコっとチョコレート",
  "スキーが好き",
  "ハートありがとう！ハートハート",
  "ワインはうまいん",
  "タイが鯛焼きを食べたい",
  "パンダのパンだ",
  "今日の配信も最高でした、ありがとうございました",
];

let tokenizer: Tokenizer;
beforeAll(async () => {
  tokenizer = await buildTokenizer();
});

describe("ダジャレの判定（旧 kametti の Shareka と同じ結果）", () => {
  it.each(SENTENCES)("「%s」で旧版と同じ結果になる", (sentence) => {
    const legacy = new LegacyShareka(sentence, 2, tokenizer).dajarewake();
    expect(isDajareReading(toReading(tokenizer, sentence))).toBe(legacy);
  });

  it("代表的なダジャレをダジャレ候補とし、普通のあいさつは候補にしない", () => {
    const judge = (s: string) => isDajareReading(toReading(tokenizer, s));
    expect(judge("布団が吹っ飛んだ")).toBe(true);
    expect(judge("アルミ缶の上にあるミカン")).toBe(true);
    expect(judge("こんにちは")).toBe(false);
  });
});

describe("isDajareReading", () => {
  it("記号・空白・「ッ」「ー」を消し、小書きの文字を大きくする", () => {
    expect(normalizeReading("ショッピング、ー！　ァ")).toBe("シヨピングア");
  });

  it("短すぎる・空の読みはダジャレ候補にしない", () => {
    expect(isDajareReading("")).toBe(false);
    expect(isDajareReading("ア")).toBe(false);
  });

  it("同じ組が全体の半分を超える繰り返しは、ダジャレ候補にしない", () => {
    expect(isDajareReading("ハハハハハ")).toBe(false);
  });
});

describe("DajareJudge", () => {
  it("辞書を読み込むまでは判定しない（表記のままでは判定しない）", async () => {
    const judge = new DajareJudge();
    expect(judge.isReady()).toBe(false);
    expect(judge.judge("布団が吹っ飛んだ")).toBe(false);
    await judge.init(async () => tokenizer);
    expect(judge.judge("布団が吹っ飛んだ")).toBe(true);
  });
});
