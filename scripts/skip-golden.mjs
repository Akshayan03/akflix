// Golden fingerprint for the Roku bridge's Python port (akflix-roku
// bridge/akflix_skip.py, checked by tests/bridge/test_skip.py): an
// integer-only signal both languages build bit for bit, fingerprinted by
// src/lib/skip/fingerprint.ts.
//
//   node scripts/skip-golden.mjs > <akflix-roku>/tests/bridge/skip_golden.json
import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["src/lib/skip/fingerprint.ts"],
  bundle: true, write: false, platform: "node", format: "esm",
});
const { fingerprintPcm } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

/** Sawtooth notes (new pitch and level every 0.3 s) plus noise, integers only. */
export function goldenSignal(seconds = 20, seed = 20261018) {
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const out = new Int16Array(seconds * 8000);
  let period = 40;
  let amp = 6000;
  for (let n = 0; n < out.length; n += 1) {
    if (n % 2400 === 0) {
      period = 18 + ((next() >>> 24) % 70);
      amp = 3000 + ((next() >>> 20) % 6000);
    }
    const saw = Math.floor(((n % period) * 2 * amp) / period) - amp;
    const noise = ((next() >>> 22) % 801) - 400;
    out[n] = saw + noise;
  }
  return out;
}

const seconds = 20;
const seed = 20261018;
const print = fingerprintPcm(goldenSignal(seconds, seed));
process.stdout.write(JSON.stringify({ seconds, seed, hashes: Array.from(print.hashes), quiet: Array.from(print.quiet) }) + "\n");
