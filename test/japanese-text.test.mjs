import assert from "node:assert/strict";
import { test } from "node:test";

import { isChildHiragana, toChildHiragana } from "../lib/japanese-text.mjs";

test("child-facing Japanese is converted from kanji and katakana to hiragana", async () => {
  const converted = await toChildHiragana("ひなたちゃん、恐竜とママのお話をしようね。");
  assert.equal(converted, "ひなたちゃん、きょうりゅうとままのおはなしをしようね。");
  assert.equal(isChildHiragana(converted), true);
});

test("child-facing text rejects leftover alphabet characters", () => {
  assert.equal(isChildHiragana("れごであそぼうね。"), true);
  assert.equal(isChildHiragana("LEGOであそぼうね。"), false);
});
