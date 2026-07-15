import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const binaries = resolve("src-tauri/binaries");
for (const name of ["rqbit", "ffmpeg"]) {
  const output = resolve(binaries, `${name}-universal-apple-darwin`);
  if (existsSync(output)) continue;
  execFileSync("lipo", [
    "-create",
    resolve(binaries, `${name}-aarch64-apple-darwin`),
    resolve(binaries, `${name}-x86_64-apple-darwin`),
    "-output",
    output,
  ], { stdio: "inherit" });
}
