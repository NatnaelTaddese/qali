#!/usr/bin/env node
// Renders the web app's notification sounds to the Mac app's bundled CAFs:
//   node apps/macos/scripts/render-sounds.mjs           (headless Chrome/Brave)
//   node apps/macos/scripts/render-sounds.mjs --serve   (open the page yourself)
//
// The web synthesizes them live with cuelume (apps/web/src/lib/notification-
// sounds.ts); the Mac plays files, and macOS notifications can only sound a
// file from the bundle. So this runs cuelume's own engine and recipes in a
// headless Chromium (Chrome or Brave; set CHROME to pick a binary) with an
// OfflineAudioContext and writes what it renders, so both apps sound alike.
// Re-run it after a cuelume upgrade or a change to SOUNDS.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../Qali/Resources/Sounds");

/** Mac file name → cuelume sound, as the web's SOUND_FOR_KIND maps them. */
const SOUNDS = {
  "qali-reminder": "chime",
  "qali-booking": "arrival",
};

// The web app's own copy (installed with `bun install`), so the Mac renders
// whatever version the web plays.
const dist = resolve(here, "../../web/node_modules/cuelume/dist");
if (!existsSync(dist)) throw new Error("cuelume isn't installed; run bun install.");
const strip = (source) =>
  source
    .replace(/^import .*$/gm, "")
    .replace(/^export (const|function|let) /gm, "$1 ");
const recipes = strip(readFileSync(join(dist, "sounds/recipes.js"), "utf8"));
const engine = strip(readFileSync(join(dist, "audio/engine.js"), "utf8"));

const page = `<!doctype html><meta charset="utf-8"><body><script>
${recipes}
${engine}
const RATE = 48000;
function wav(samples) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  let binary = "";
  new Uint8Array(view.buffer).forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
(async () => {
  for (const [file, name] of Object.entries(${JSON.stringify(SOUNDS)})) {
    const recipe = RECIPES[name];
    // A fresh output stage per sound: the engine caches one per context.
    sharedOutput = null;
    const seconds = sourceEnd(recipe) + shimmerTail(recipe.shimmer) + 0.1;
    const context = new OfflineAudioContext(1, Math.ceil(seconds * RATE), RATE);
    renderRecipe(context, recipe, 1);
    const buffer = await context.startRendering();
    const audio = wav(buffer.getChannelData(0));
    // Served (--serve), the page hands each sound back to the script;
    // headless, the script reads them out of the dumped DOM.
    if (location.protocol === "http:") await fetch("/save/" + file, { method: "POST", body: audio });
    const pre = document.createElement("pre");
    pre.id = file;
    pre.textContent = audio;
    document.body.append(pre);
  }
  document.body.dataset.done = "1";
})();
</script>`;

/** Writes one rendered WAV (base64) as the bundled CAF. */
function save(work, file, base64) {
  const wavPath = join(work, `${file}.wav`);
  writeFileSync(wavPath, Buffer.from(base64, "base64"));
  const caf = join(out, `${file}.caf`);
  execFileSync("afconvert", ["-f", "caff", "-d", "LEI16", wavPath, caf]);
  console.log(`wrote ${caf}`);
}

const work = mkdtempSync(join(tmpdir(), "qali-sounds-"));

if (process.argv.includes("--serve")) {
  // `--serve [port]`: open http://localhost:<port> in any Chromium-based
  // browser; the script exits once every sound is written.
  const port = Number(process.argv[process.argv.indexOf("--serve") + 1]) || 4789;
  const pending = new Set(Object.keys(SOUNDS));
  const server = createServer((req, res) => {
    const name = req.url?.match(/^\/save\/([\w-]+)$/)?.[1];
    if (req.method === "POST" && name && pending.has(name)) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        save(work, name, body);
        pending.delete(name);
        res.end("ok");
        if (pending.size === 0) {
          rmSync(work, { recursive: true, force: true });
          setTimeout(() => process.exit(0), 200);
        }
      });
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page);
  });
  server.listen(port, () => console.log(`open http://localhost:${port}`));
} else {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ].filter(Boolean);
  const chrome = candidates.find((path) => existsSync(path));
  if (!chrome) throw new Error("No Chromium found; set CHROME to its binary, or use --serve.");
  try {
    const html = join(work, "render.html");
    writeFileSync(html, page);
    const dom = execFileSync(
      chrome,
      [
        "--headless=new",
        `--user-data-dir=${join(work, "profile")}`,
        "--no-first-run",
        "--virtual-time-budget=15000",
        "--dump-dom",
        pathToFileURL(html).href,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    if (!dom.includes('data-done="1"')) throw new Error("The page didn't finish rendering.");
    for (const file of Object.keys(SOUNDS)) {
      const match = dom.match(new RegExp(`<pre id="${file}">([^<]+)</pre>`));
      if (!match) throw new Error(`No audio for ${file}.`);
      save(work, file, match[1]);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
