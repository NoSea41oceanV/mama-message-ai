import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const scripts = join(workspace, "scripts");
const screenshots = join(workspace, "docs", "submission", "screenshots");
const videoDirectory = join(workspace, "docs", "submission", "video");
const specImage = join(workspace, "成果物", "仕様イメージ", "01_AI_HACK_利用シーン仕様イラスト.png");
const output = join(videoDirectory, "AI_HACK_2026_3min_demo_draft.webm");
const reviewOutput = join(videoDirectory, "AI_HACK_2026_3min_demo_review.webm");
const port = Number(process.env.DEMO_VIDEO_PORT || 4180);

await mkdir(join(videoDirectory, "audio"), { recursive: true });

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
    res.writeHead(200, { "content-type": contentTypes[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") return sendFile(res, join(scripts, "demo-video-renderer.html"));
  if (req.method === "GET" && url.pathname === "/scenes.json") return sendFile(res, join(scripts, "demo-video-scenes.json"));
  if (req.method === "GET" && url.pathname === "/spec/use-scene.png") return sendFile(res, specImage);
  if (req.method === "GET" && url.pathname.startsWith("/screenshots/")) {
    return sendFile(res, join(screenshots, basename(decodeURIComponent(url.pathname))));
  }
  if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
    return sendFile(res, join(videoDirectory, "audio", basename(decodeURIComponent(url.pathname))));
  }
  if (req.method === "GET" && url.pathname === "/video") return sendFile(res, output);
  if (req.method === "GET" && url.pathname === "/review-video") return sendFile(res, reviewOutput);
  if (req.method === "POST" && url.pathname === "/upload") {
    let size = 0;
    const target = createWriteStream(output);
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 180 * 1024 * 1024) req.destroy(new Error("video too large"));
    });
    req.pipe(target);
    target.on("finish", () => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ output, size }));
      console.log(`Saved ${output} (${size} bytes)`);
    });
    target.on("error", (error) => res.writeHead(500).end(error.message));
    return;
  }
  if (req.method === "GET" && url.pathname === "/status") {
    try {
      const info = await stat(output);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: true, output, size: info.size }));
    } catch {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: false }));
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Demo video renderer: http://127.0.0.1:${port}`);
});
