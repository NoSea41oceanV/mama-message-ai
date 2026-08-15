import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps an inline follow-up reply within the fixed response screen", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /\/styles\.css\?v=29/);
  assert.match(html, /\/app\.js\?v=39/);
  assert.match(css, /\.screen\[data-screen="response"\] \{ overflow: hidden; \}/);
  assert.match(css, /grid-template-rows: auto minmax\(150px, 1fr\) auto auto 184px auto;/);
  assert.match(css, /\.response-conversation \{[^}]*height: 184px;[^}]*overflow: hidden;/);
  assert.match(css, /\.response-conversation\.is-confirming \.response-talk-row/);
  assert.match(app, /function setResponseTranscriptVisible\(visible\)/);
  assert.match(app, /responseConversation\.classList\.toggle\("is-confirming", visible\)/);
});

test("records the guided voice sample sentence by sentence and stores speaking style per situation", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="scenarioStyleFields"/);
  assert.match(html, /data-registration-step="0"/);
  assert.match(html, /data-registration-panel="3"/);
  assert.match(html, /id="registrationStepNext"/);
  assert.match(html, /id="sampleSentenceProgress"/);
  assert.match(html, /class="sample-sentence-list"/);
  assert.match(html, /例はそのまま読まなくて大丈夫です/);
  assert.doesNotMatch(html, /ブラウザ内で1本のWAVへ結合/);
  assert.match(html, /登録した写真と声は、いつでも削除できます/);
  assert.match(app, /sampleVoiceClips: Array\(24\)\.fill\(null\)/);
  assert.match(app, /async function combineRecordedSampleClips\(\)/);
  assert.match(app, /function encodeMonoWav\(samples/);
  assert.match(app, /document\.querySelectorAll\("\.scenario-style-input"\)/);
  assert.match(app, /if \(!sample\?\.configured\)/);
  assert.match(app, /showScreen\("registration"\)/);
  assert.match(app, /登録してホームへ/);
  assert.match(app, /className = "sample-sentence-choice"/);
  assert.match(app, /伝える内容：\$\{prompt\.intent\}/);
  assert.match(app, /例：\$\{prompt\.example\}/);
  assert.doesNotMatch(app, /setTimeout\(stopSampleRecording/);
  assert.match(html, /← 前の場面/);
  assert.match(html, /次の場面 →/);
});
