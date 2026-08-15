import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps an inline follow-up reply within the fixed response screen", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /\/styles\.css\?v=25/);
  assert.match(html, /\/app\.js\?v=31/);
  assert.match(css, /\.screen\[data-screen="response"\] \{ overflow: hidden; \}/);
  assert.match(css, /grid-template-rows: auto minmax\(150px, 1fr\) auto auto 184px auto;/);
  assert.match(css, /\.response-conversation \{[^}]*height: 184px;[^}]*overflow: hidden;/);
  assert.match(css, /\.response-conversation\.is-confirming \.response-talk-row/);
  assert.match(app, /function setResponseTranscriptVisible\(visible\)/);
  assert.match(app, /responseConversation\.classList\.toggle\("is-confirming", visible\)/);
});
