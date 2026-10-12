// Live regression tests for the embedded playback engine.
//
// Runs the bundled rqbit binary with the app's own flags on loopback-only
// ports, seeds generated test media (lavfi test pattern + tone) from a second
// rqbit, and drives the app's real RqbitClient against it. Every request that
// would leave this machine (metadata cache, public trackers) is rewritten to a
// local server or rejected, so the run is hermetic.
//
//   node scripts/test-embedded-engine.mjs [--app-src <dir>]
//
// --app-src bundles RqbitClient from another checkout (for red/green runs).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const argIndex = process.argv.indexOf("--app-src");
const appSrc = argIndex > 0 ? resolve(process.argv[argIndex + 1]) : join(root, "src");
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const rqbit = process.env.AKFLIX_RQBIT ?? join(root, `src-tauri/binaries/rqbit-${arch}-apple-darwin`);
const ffmpeg = process.env.AKFLIX_FFMPEG ?? join(root, `src-tauri/binaries/ffmpeg-${arch}-apple-darwin`);
for (const binary of [rqbit, ffmpeg]) {
  if (!existsSync(binary)) throw new Error(`Missing bundled binary ${binary}; set AKFLIX_RQBIT/AKFLIX_FFMPEG.`);
}

const work = mkdtempSync(join(process.env.AKFLIX_TEST_TMP ?? tmpdir(), "akflix-engine-test-"));
const seedDir = join(work, "seed");
const stateDir = join(work, "Engine");
const mediaDir = join(work, "Media");
for (const dir of [seedDir, stateDir, mediaDir]) mkdirSync(dir, { recursive: true });
const NAME = "Akflix.Engine.Test.2026.360p.H264.mp4";
const children = [];
const base = 40_000 + (process.pid % 2_000) * 4;
const ports = { seederApi: base, seederPeer: base + 1, engineApi: base + 2, enginePeer: base + 3 };
const engineUrl = `http://127.0.0.1:${ports.engineApi}`;

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (typeof value === "string") return bencode(Buffer.from(value));
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  const keys = Object.keys(value).sort();
  return Buffer.concat([Buffer.from("d"), ...keys.flatMap((key) => [bencode(key), bencode(value[key])]), Buffer.from("e")]);
}

/** Synthesize a moving test pattern and a 440 Hz tone, then encode them as H.264/AAC MP4. */
function generateMedia(path) {
  const width = 320;
  const height = 240;
  const fps = 24;
  const seconds = 15;
  const frame = Buffer.alloc((width * height * 3) / 2);
  const video = Buffer.alloc(frame.length * fps * seconds);
  for (let index = 0; index < fps * seconds; index += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        frame[y * width + x] = (x + y + index * 4) & 0xff;
      }
    }
    frame.fill(128 + ((index * 3) % 64), width * height);
    frame.copy(video, index * frame.length);
  }
  const rawVideo = join(work, "pattern.yuv");
  writeFileSync(rawVideo, video);
  const rate = 48_000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample += 1) {
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * sample) / rate) * 12_000), 44 + sample * 2);
  }
  const tone = join(work, "tone.wav");
  writeFileSync(tone, wav);
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${width}x${height}`, "-r", String(fps), "-i", rawVideo,
    "-i", tone, "-map", "0:v:0", "-map", "1:a:0", "-shortest",
    "-c:v", "h264_videotoolbox", "-b:v", "1200k", "-allow_sw", "1",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", path,
  ], { encoding: "utf8" });
  rmSync(rawVideo, { force: true });
  if (result.status !== 0) throw new Error(`ffmpeg could not generate test media: ${result.stderr}`);
}

function startEngine(args, logName) {
  const child = spawn(rqbit, args, { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  child.stderr.on("data", (chunk) => { log = (log + chunk).slice(-20_000); });
  children.push(child);
  child.logTail = () => log.slice(-2_000);
  child.logName = logName;
  return child;
}

async function waitFor(check, timeoutMs, message) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`${message}${lastError ? ` (${lastError})` : ""}`);
}

const api = async (path, init) => fetch(`${engineUrl}${path}`, init);
const stats = async (hash) => (await (await api(`/torrents/${hash}/stats/v1`)).json());

let infoHash = "";
let magnet = "";
let mediaBytes;
let torrentBytes;
let RqbitClient;
let EngineStorageError;
let server;

before(async () => {
  const mediaPath = join(seedDir, NAME);
  generateMedia(mediaPath);
  mediaBytes = readFileSync(mediaPath);
  const pieceLength = 256 * 1024;
  const pieces = [];
  for (let offset = 0; offset < mediaBytes.length; offset += pieceLength) {
    pieces.push(createHash("sha1").update(mediaBytes.subarray(offset, offset + pieceLength)).digest());
  }
  const info = { length: mediaBytes.length, name: NAME, "piece length": pieceLength, pieces: Buffer.concat(pieces) };

  // Loopback tracker + metadata cache standing in for itorrents.org.
  server = createServer((request, response) => {
    if (request.url?.startsWith("/announce")) {
      const peer = Buffer.alloc(6);
      [127, 0, 0, 1].forEach((part, index) => peer.writeUInt8(part, index));
      peer.writeUInt16BE(ports.seederPeer, 4);
      response.end(Buffer.concat([Buffer.from("d8:intervali30e5:peers6:"), peer, Buffer.from("e")]));
    } else if (request.url === `/${infoHash.toUpperCase()}.torrent`) {
      response.end(torrentBytes);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const trackerUrl = `http://127.0.0.1:${server.address().port}/announce`;
  torrentBytes = bencode({ announce: trackerUrl, info });
  infoHash = createHash("sha1").update(bencode(info)).digest("hex");
  magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(NAME)}&tr=${encodeURIComponent(trackerUrl)}`;

  const isolation = ["--disable-dht", "--disable-dht-persistence", "--disable-upnp-port-forward", "--disable-lsd", "--listen-ip", "127.0.0.1"];
  startEngine([...isolation, "--http-api-listen-addr", `127.0.0.1:${ports.seederApi}`, "--listen-port", String(ports.seederPeer),
    "server", "start", "--disable-persistence", seedDir], "seeder");
  // Same flags as start_embedded_torrent_engine() in src-tauri/src/lib.rs.
  startEngine([...isolation, "--http-api-listen-addr", `127.0.0.1:${ports.engineApi}`, "--peer-limit", "55",
    "--peer-connect-timeout", "2s", "--peer-read-write-timeout", "4s", "--listen-port", String(ports.enginePeer),
    "server", "start", "--fastresume", "--persistence-location", stateDir, mediaDir], "engine");
  await waitFor(async () => (await fetch(`http://127.0.0.1:${ports.seederApi}/`)).ok, 15_000, "seeder did not start");
  await waitFor(async () => (await api("/")).ok, 15_000, "engine did not start");
  const seeded = await fetch(`http://127.0.0.1:${ports.seederApi}/torrents?overwrite=true`, { method: "POST", body: torrentBytes });
  assert.equal(seeded.status, 200, await seeded.text());
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${ports.seederApi}/torrents/${infoHash}/stats/v1`);
    return response.ok && (await response.json()).finished;
  }, 30_000, "seeder did not verify the generated media");

  // Hermetic network: the app's metadata cache becomes the loopback server and
  // public trackers are stripped. Anything else non-local is refused.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== "127.0.0.1") throw new Error(`blocked non-local request to ${url.hostname}`);
    let body = init.body;
    if (typeof body === "string" && url.pathname === "/torrents" && init.method === "POST") {
      body = body.replace(/^https:\/\/itorrents\.org\/torrent\//, `http://127.0.0.1:${server.address().port}/`);
      if (body.startsWith("magnet:")) {
        const [head, query] = body.split("?");
        const params = new URLSearchParams(query);
        const trackers = params.getAll("tr").filter((tracker) => tracker.startsWith("http://127.0.0.1:"));
        params.delete("tr");
        for (const tracker of trackers) params.append("tr", tracker);
        body = `${head}?${params}`;
      }
    }
    return realFetch(input, { ...init, body });
  };

  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const { build } = createRequire(join(root, "package.json"))("esbuild");
  const bundled = await build({
    stdin: { contents: `export * from ${JSON.stringify(join(appSrc, "api/rqbit.ts"))};`, resolveDir: root, loader: "ts" },
    bundle: true, write: false, platform: "node", format: "esm",
    alias: { "@": appSrc },
    plugins: [{
      name: "no-tauri",
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/(api\/core|plugin-http)$/ }, () => ({ path: "tauri", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const invoke = async () => { throw new Error('no native shell'); }; export const fetch = globalThis.fetch;" }));
      },
    }],
  });
  const moduleFile = join(work, "rqbit-client.mjs");
  writeFileSync(moduleFile, bundled.outputFiles[0].text);
  ({ RqbitClient, EngineStorageError } = await import(moduleFile));
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  server?.close();
  try { chmodSync(stateDir, 0o755); } catch { /* already writable */ }
  if (!process.env.AKFLIX_KEEP_TEST_FILES) rmSync(work, { recursive: true, force: true });
});

async function removeFromEngine() {
  const response = await api(`/torrents/${infoHash}/delete`, { method: "POST" });
  if (response.ok) await waitFor(async () => (await api(`/torrents/${infoHash}`)).status === 404, 10_000, "delete did not finish");
}

async function streamedBytes(start, end, timeoutMs = 20_000) {
  const response = await fetch(`${engineUrl}/torrents/${infoHash}/stream/0`, {
    headers: { Range: `bytes=${start}-${end}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 206) assert.fail(`stream answered ${response.status}: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

test("a reused paused torrent resumes and its stream delivers the real bytes", async () => {
  const client = new RqbitClient(engineUrl);
  await client.add(magnet, "download");
  await waitFor(async () => (await stats(infoHash)).state === "live", 15_000, "torrent did not start");
  assert.equal((await api(`/torrents/${infoHash}/pause`, { method: "POST" })).status, 200);
  await waitFor(async () => (await stats(infoHash)).state === "paused", 5_000, "torrent did not pause");

  await client.add(magnet, "stream");
  await waitFor(async () => (await stats(infoHash)).state === "live", 5_000, "reused torrent stayed paused");
  const tail = mediaBytes.length - 1;
  const bytes = await streamedBytes(tail - 65_535, tail);
  assert.ok(bytes.equals(mediaBytes.subarray(tail - 65_535)), "streamed tail differs from the source");
  await removeFromEngine();
});

test("an empty leftover file from an earlier failed add does not block the release", async () => {
  await removeFromEngine();
  // Exactly what a failed or abandoned add leaves in the media folder.
  writeFileSync(join(mediaDir, NAME), "");
  const client = new RqbitClient(engineUrl);
  await client.add(magnet, "stream");
  // Same order as StreamController: select the file, then hand the URL to the player.
  assert.equal((await client.prioritizeVideoFile(infoHash))?.name, NAME);
  const full = await streamedBytes(0, mediaBytes.length - 1);
  assert.equal(createHash("sha256").update(full).digest("hex"), createHash("sha256").update(mediaBytes).digest("hex"));
  assert.equal(statSync(join(mediaDir, NAME)).size, 0, "the unrelated leftover must not be overwritten");
  await removeFromEngine();
});

test("the streamed file decodes as real video", async () => {
  rmSync(join(mediaDir, NAME), { force: true });
  const client = new RqbitClient(engineUrl);
  await client.add(magnet, "stream");
  const selected = await client.prioritizeVideoFile(infoHash);
  assert.equal(selected?.name, NAME);
  const decode = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", client.streamUrl(infoHash, selected.index),
    "-t", "5", "-map", "0:v:0", "-f", "null", "-"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(decode.status, 0, decode.stderr);
  await removeFromEngine();
});

test("an unwritable engine state folder is reported as a storage failure, not tried six times", async () => {
  await removeFromEngine();
  chmodSync(stateDir, 0o555);
  try {
    const client = new RqbitClient(engineUrl);
    await assert.rejects(client.add(magnet, "stream"), (error) => {
      assert.equal(error?.name, "EngineStorageError", String(error));
      assert.ok(error instanceof EngineStorageError);
      return true;
    });
  } finally {
    chmodSync(stateDir, 0o755);
  }
});
