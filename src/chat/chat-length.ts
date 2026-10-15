/** Spoon のチャットの上限（仕様書 §7.2。OAPI_MNGR_0109） */
export const CHAT_MAX_LENGTH = 200;

/** Spoon のチャットでの文字数。絵文字など BMP 外の文字は2文字として数える（UTF-16 の長さ） */
export function chatLength(text: string): number {
  let length = 0;
  for (const char of text) length += (char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  return length;
}
