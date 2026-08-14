import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dailyPackage = JSON.parse(await readFile(resolve(projectRoot, "node_modules/@daily-co/daily-js/package.json"), "utf8"));
const supportedBundles = {
  "0.92.0": {
    "call-machine-object-bundle.js": "d3564af3295daf30d11f5bc5ed4305201807374d56909331e520fa728a823f4c",
    "audio-processor-bundle.js": "a0b6d2ad8b73b2daf6530e4e1ca8e82f720fa5c2f2c13a7b5209010575e45a21",
  },
};

const expectedBundles = supportedBundles[dailyPackage.version];
if (!expectedBundles) {
  throw new Error(`Daily ${dailyPackage.version} is not pinned for the embedded runtime`);
}

const cacheDirectory = resolve(projectRoot, "public/vendor/daily-call-machine");
await mkdir(cacheDirectory, { recursive: true });

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function loadVerifiedBundle(fileName, expectedHash) {
  const filePath = resolve(cacheDirectory, fileName);
  let content = await readFile(filePath).catch(() => null);
  if (!content || sha256(content) !== expectedHash) {
    const url = `https://c.daily.co/call-machine/versioned/${dailyPackage.version}/static/${fileName}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${fileName}: HTTP ${response.status}`);
    content = Buffer.from(await response.arrayBuffer());
    if (sha256(content) !== expectedHash) throw new Error(`Integrity check failed for ${fileName}`);
    await writeFile(filePath, content);
  }
  return content.toString("utf8");
}

const [callMachine, audioProcessor] = await Promise.all(
  Object.entries(expectedBundles).map(([fileName, hash]) => loadVerifiedBundle(fileName, hash)),
);
const bundledRuntime = `${callMachine}\n;${audioProcessor}`;
const buildResult = await build({
  entryPoints: [resolve(projectRoot, "node_modules/@daily-co/daily-js/dist/daily-esm.js")],
  bundle: true,
  format: "iife",
  globalName: "DailySDK",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
});
const dailySdk = buildResult.outputFiles[0].text;
const embeddedRuntime = [
  dailySdk,
  ";globalThis.MamaDailyRuntime=(()=>{",
  `const source=${JSON.stringify(bundledRuntime)};`,
  "let url=null;",
  "return {createBundleUrl(){",
  "if(!url)url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));",
  "return url;",
  "}};",
  "})();",
].join("");

const outputPath = resolve(projectRoot, "public/vendor/daily-sdk.js");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, embeddedRuntime);
