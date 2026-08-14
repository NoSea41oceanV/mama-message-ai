import KuroshiroModule from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";

const Kuroshiro = KuroshiroModule.default ?? KuroshiroModule;
const kuroshiro = new Kuroshiro();
const ready = kuroshiro.init(new KuromojiAnalyzer());

const CHILD_TEXT_FORBIDDEN_PATTERN = /[一-龯々〆ヵヶァ-ヴA-Za-z]/u;

export async function toChildHiragana(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  await ready;
  const converted = await kuroshiro.convert(source, { to: "hiragana", mode: "normal" });
  return Kuroshiro.Util.kanaToHiragna(converted)
    .replace(/\s+/g, " ")
    .trim();
}

export function isChildHiragana(value) {
  const source = String(value ?? "").trim();
  return Boolean(source) && !CHILD_TEXT_FORBIDDEN_PATTERN.test(source);
}
