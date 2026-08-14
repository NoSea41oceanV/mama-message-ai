import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outputDirectory = fileURLToPath(new URL("../docs/submission/video/live/", import.meta.url));
const outputPath = join(outputDirectory, "AI_HACK_2026_live_app.webm");
const appUrl = process.env.DEMO_APP_URL || "http://127.0.0.1:4173/";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const fallback = join(
      process.env.USERPROFILE || "C:\\Users\\kachi",
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
      "playwright",
      "index.mjs",
    );
    return import(pathToFileURL(fallback).href);
  }
}

async function pause(page, milliseconds) {
  await page.waitForTimeout(milliseconds);
}

async function waitForScreen(page, name, timeout = 30_000) {
  await page.locator(`[data-screen="${name}"]:not([hidden])`).waitFor({ state: "visible", timeout });
}

async function runTurn(page, text, responseHoldMs = 6_000) {
  await page.locator("#demoAudioButton").click();
  await waitForScreen(page, "transcript");
  await page.locator("#transcriptInput").fill(text);
  await pause(page, 2_600);
  await page.locator("#confirmButton").click();
  await waitForScreen(page, "waiting");
  await Promise.race([
    page.locator('[data-screen="response"]').waitFor({ state: "visible", timeout: 35_000 }),
    page.locator('[data-screen="safety"]').waitFor({ state: "visible", timeout: 35_000 }),
  ]);
  await pause(page, responseHoldMs);
}

const { chromium } = await loadPlaywright();
await mkdir(outputDirectory, { recursive: true });
await rm(outputPath, { force: true });

const executablePath = process.env.BROWSER_EXECUTABLE
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath, headless: true });
let context;

try {
  context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: "ja-JP",
    colorScheme: "light",
    recordVideo: {
      dir: outputDirectory,
      size: { width: 1280, height: 720 },
    },
  });
  const page = await context.newPage();
  const video = page.video();
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.locator("#childModeButton").click();
  await page.locator("#startSetup").waitFor({ state: "visible" });
  await page.locator("#startSetup").waitFor({ state: "attached" });
  await pause(page, 3_000);

  await page.locator("#startSetup").click();
  await waitForScreen(page, "record");
  await pause(page, 2_000);

  await runTurn(page, "ママに会えなくて、ちょっとさみしいよ", 7_000);

  await page.locator("#talkAgainButton").click();
  await waitForScreen(page, "record");
  await pause(page, 1_800);
  await runTurn(page, "ブロックでおうちを作ったよ。おへやはふたつだよ", 7_000);

  await page.locator("#finishButton").click();
  await waitForScreen(page, "setup");
  await pause(page, 1_000);
  await page.locator("#startSetup").click();
  await waitForScreen(page, "record");
  await pause(page, 1_500);

  await runTurn(page, "知らない人が玄関にいてこわい。助けて", 7_000);
  await pause(page, 1_000);

  await context.close();
  context = null;
  const recordedPath = await video.path();
  await rename(recordedPath, outputPath);
  console.log(`Saved live app recording: ${outputPath}`);
} finally {
  if (context) await context.close().catch(() => {});
  await browser.close();
}
