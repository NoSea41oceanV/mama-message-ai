import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const workspace=fileURLToPath(new URL("../",import.meta.url));
const video=join(workspace,"docs","submission","video","AI_HACK_2026_ohenji_current_explainer.webm");
const review=join(workspace,"docs","submission","video","current-explainer-review");
const fallback=join(process.env.USERPROFILE,".cache","codex-runtimes","codex-primary-runtime","dependencies","node","node_modules","playwright","index.mjs");
const {chromium}=await import(pathToFileURL(fallback).href);await mkdir(review,{recursive:true});
const browser=await chromium.launch({executablePath:"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",headless:true});
try{const page=await browser.newPage({viewport:{width:1280,height:720}});await page.goto(pathToFileURL(video).href);const media=page.locator("video");await media.waitFor({state:"visible"});const metadata=await media.evaluate(element=>({duration:element.duration,width:element.videoWidth,height:element.videoHeight,readyState:element.readyState}));for(const second of [2,31,56,83]){await media.evaluate((element,time)=>new Promise(resolve=>{element.onseeked=resolve;element.currentTime=time}),second);await page.screenshot({path:join(review,`frame-${String(second).padStart(2,"0")}.png`)})}console.log(JSON.stringify({video,review,metadata}))}finally{await browser.close()}
