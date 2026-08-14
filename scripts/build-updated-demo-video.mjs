import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const scripts = join(workspace, "scripts");
const videoDirectory = join(workspace, "docs", "submission", "video");
const audioDirectory = join(videoDirectory, "live-v2-audio");
const output = join(videoDirectory, "AI_HACK_2026_3min_demo_live_v2.webm");
const temporaryOutput = `${output}.part`;
const port = Number(process.env.UPDATED_DEMO_PORT || 4181);

const assets = {
  "/assets/situation-babysitter-child.png": join(videoDirectory, "assets", "situation-babysitter-child.png"),
  "/assets/messenger-mascot.png": join(workspace, "public", "assets", "messenger-mascot.png"),
  "/live/app.webm": join(videoDirectory, "live", "AI_HACK_2026_live_app.webm"),
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

async function sendFile(res, path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": contentTypes[extname(path)] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store",
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
}

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

await mkdir(videoDirectory, { recursive: true });
await rm(temporaryOutput, { force: true });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") return sendFile(res, join(scripts, "updated-demo-renderer.html"));
  if (req.method === "GET" && url.pathname === "/scenes.json") return sendFile(res, join(scripts, "updated-demo-scenes.json"));
  if (req.method === "GET" && assets[url.pathname]) return sendFile(res, assets[url.pathname]);
  if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
    return sendFile(res, join(audioDirectory, basename(decodeURIComponent(url.pathname))));
  }
  if (req.method === "POST" && url.pathname === "/upload") {
    let size = 0;
    const target = createWriteStream(temporaryOutput, { flags: "wx" });
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 250 * 1024 * 1024) req.destroy(new Error("video too large"));
    });
    req.pipe(target);
    target.on("finish", async () => {
      try {
        await rm(output, { force: true });
        await rename(temporaryOutput, output);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ output, size }));
      } catch (error) {
        res.writeHead(500).end(error.message);
      }
    });
    target.on("error", (error) => res.writeHead(500).end(error.message));
    return;
  }
  res.writeHead(404).end("not found");
});

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const { chromium } = await loadPlaywright();
const executablePath = process.env.BROWSER_EXECUTABLE
  || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath, headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, locale: "ja-JP" });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await page.locator("#start").click();
  await page.waitForFunction(() => document.title.startsWith("DONE -"), null, { timeout: 220_000 });
  const info = await stat(output);
  console.log(`Saved updated submission video: ${output} (${info.size} bytes)`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
