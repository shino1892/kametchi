// @ts-nocheck 旧 kametti のコードをそのまま写したもので、当時の緩い型チェックの設定で書かれているため
/**
 * 旧 kametti（コミット a6f2cb1 の前、src/discord/bot.ts）の Shareka をそのまま写したもの。
 * 新しい判定（src/dajare/shareka.ts）が旧版と同じ結果になることを確かめるために使う。
 * 変えたのは、グローバルの tokenizer を引数で受け取るようにしたことだけ。
 */
import type kuromoji from "kuromoji";

export class LegacyShareka {
  private replace_words = [
    ["。", ""],
    ["、", ""],
    [",", ""],
    [".", ""],
    ["!", ""],
    ["！", ""],
    ["・", ""],
    ["「", ""],
    ["」", ""],
    ["「", ""],
    ["｣", ""],
    ["『", ""],
    ["』", ""],
    [" ", ""],
    ["　", ""],
    ["ッ", ""],
    ["ャ", "ヤ"],
    ["ュ", "ユ"],
    ["ョ", "ヨ"],
    ["ァ", "ア"],
    ["ィ", "イ"],
    ["ゥ", "ウ"],
    ["ェ", "エ"],
    ["ォ", "オ"],
    ["ッ", ""],
    ["ー", ""],
  ];
  private kaburi: number;
  private sentence: string;
  private preprocessed: string;
  private devided: string[];

  constructor(
    sentence: string,
    n = 3,
    tokenizer: kuromoji.Tokenizer<kuromoji.IpadicFeatures> | null = null,
  ) {
    this.kaburi = n;
    this.sentence = sentence;

    // 読みの取得 (MeCab -Oyomi の代わり)
    const kana = tokenizer
      ? tokenizer
          .tokenize(sentence)
          .map((t) => t.reading || t.surface_form)
          .join("")
      : sentence;

    this.preprocessed = this.preprocessing(kana);
    this.devided = this.devide(this.preprocessed);
  }

  private preprocessing(sentence: string): string {
    let result = sentence;
    for (const [target, replacement] of this.replace_words) {
      result = result.split(target).join(replacement);
    }
    return result;
  }

  private devide(sentence: string): string[] {
    const elements: string[] = [];
    const repeat_num = sentence.length - (this.kaburi - 1);
    for (let i = 0; i < repeat_num; i++) {
      elements.push(sentence.substring(i, i + this.kaburi)); // elements.push
    }
    // JSのArrayにappendはないので push に読み替えます
    return elements;
  }

  // 重複の最大数とその単語を取得
  private list_max_dup(): [string, number] {
    const counts: { [key: string]: number } = {};
    let maxWord = "";
    let maxCount = 0;

    for (const word of this.devided) {
      counts[word] = (counts[word] || 0) + 1;
      if (counts[word] > maxCount) {
        maxCount = counts[word];
        maxWord = word;
      }
    }
    return [maxWord, maxCount];
  }

  // 重複率の計算: (n-gramの長さ * 出現回数) / プリプロセス後の全文字数
  private sentence_max_dup_rate(maxWord: string): number {
    if (this.preprocessed.length === 0) return 1;
    const [, count] = this.list_max_dup();
    return (maxWord.length * count) / this.preprocessed.length;
  }

  public dajarewake(): boolean {
    if (this.devided.length === 0) return false;

    const [maxWord, maxCount] = this.list_max_dup();
    const rate = this.sentence_max_dup_rate(maxWord);

    // ルール: 重複が2回以上、かつ重複部分が全体の50%以下
    if (maxCount > 1 && rate <= 0.5) {
      return true;
    }
    return false;
  }
}
