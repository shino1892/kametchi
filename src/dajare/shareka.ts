import { createRequire } from "node:module";
import path from "node:path";
import kuromoji from "kuromoji";

/**
 * ダジャレの判定（仕様書 §8.2）。旧 kametti の Shareka と同じ方法で、同じ結果になる
 * （test/dajare/shareka.test.ts で旧版と比べている）。
 *
 * 1. 読み（カタカナ）にする。読みのない語は表記のまま
 * 2. 句読点・記号・空白・「ッ」「ー」を消し、小書きの「ャュョァィゥェォ」を大きい文字にする
 * 3. n 文字ずつの組に分け、最も多く出た組の回数を数える
 * 4. 回数が2以上で、かつ「組の長さ × 回数 ÷ 全体の文字数」が 0.5 以下ならダジャレ候補
 */

export type Tokenizer = kuromoji.Tokenizer<kuromoji.IpadicFeatures>;

/** 旧版と同じ順番で置き換える（順番で結果が変わるため、重複している項目もそのまま残す） */
const REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
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

/** 旧 kametti と同じ組の長さ（new Shareka(message, 2)） */
export const DEFAULT_GRAM = 2;

/** 読み（カタカナ）にする */
export function toReading(tokenizer: Tokenizer, sentence: string): string {
  return tokenizer
    .tokenize(sentence)
    .map((token) => token.reading || token.surface_form)
    .join("");
}

export function normalizeReading(reading: string): string {
  let result = reading;
  for (const [target, replacement] of REPLACEMENTS) result = result.split(target).join(replacement);
  return result;
}

/** 読みからダジャレ候補かを判定する */
export function isDajareReading(reading: string, gram = DEFAULT_GRAM): boolean {
  const text = normalizeReading(reading);
  const count = text.length - (gram - 1);
  if (count <= 0) return false;

  const counts = new Map<string, number>();
  let maxWord = "";
  let maxCount = 0;
  for (let i = 0; i < count; i++) {
    const word = text.substring(i, i + gram);
    const n = (counts.get(word) ?? 0) + 1;
    counts.set(word, n);
    // 旧版と同じく、最初に最大回数に達した組を選ぶ
    if (n > maxCount) {
      maxCount = n;
      maxWord = word;
    }
  }
  const rate = (maxWord.length * maxCount) / text.length;
  return maxCount > 1 && rate <= 0.5;
}

/** kuromoji の辞書を読み込む。辞書の場所は node_modules の配置によらず求める */
export function buildTokenizer(): Promise<Tokenizer> {
  const require = createRequire(import.meta.url);
  const dicPath = path.join(path.dirname(require.resolve("kuromoji/package.json")), "dict");
  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath }).build((error, tokenizer) => {
      if (error) reject(error);
      else resolve(tokenizer);
    });
  });
}

/**
 * 判定の窓口。辞書を読み込むまでは判定しない（表記のままで判定すると旧版と結果が変わるため）。
 */
export class DajareJudge {
  private tokenizer: Tokenizer | null = null;

  constructor(private readonly gram = DEFAULT_GRAM) {}

  /** 辞書を読み込む（起動時に1回） */
  async init(build: () => Promise<Tokenizer> = buildTokenizer): Promise<void> {
    this.tokenizer = await build();
  }

  isReady(): boolean {
    return this.tokenizer !== null;
  }

  /** ダジャレ候補か。辞書をまだ読み込んでいなければ false */
  judge(sentence: string): boolean {
    if (!this.tokenizer) return false;
    return isDajareReading(toReading(this.tokenizer, sentence), this.gram);
  }
}
