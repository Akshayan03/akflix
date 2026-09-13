import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const destination = resolve("src-tauri/models/ggml-base.en-q5_1.bin");
const temporary = `${destination}.download`;
const expectedSha256 = "4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f";
const source = "https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-base.en-q5_1.bin?download=true";

async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

if (existsSync(destination) && (await sha256(destination)) === expectedSha256) {
  process.stdout.write("Whisper caption model is ready.\n");
  process.exit(0);
}

await mkdir(dirname(destination), { recursive: true });
await unlink(temporary).catch(() => {});
process.stdout.write("Preparing the bundled Whisper caption model (about 60 MB)...\n");
const response = await fetch(source, { redirect: "follow" });
if (!response.ok || !response.body) {
  throw new Error(`Could not download caption model: HTTP ${response.status}`);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
const actualSha256 = await sha256(temporary);
if (actualSha256 !== expectedSha256) {
  await unlink(temporary).catch(() => {});
  throw new Error(`Caption model checksum mismatch: ${actualSha256}`);
}
await rename(temporary, destination);
process.stdout.write("Whisper caption model downloaded and verified.\n");
