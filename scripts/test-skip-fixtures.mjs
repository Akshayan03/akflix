// Skip intro accuracy on generated episodes (tests/skip/make_skip_fixtures.py):
// runs the real detector over every season twice (the second pass is a
// rewatch) reading audio and chapters with ffmpeg, then scores it.
//
//   node scripts/test-skip-fixtures.mjs [fixtures dir]
//
// The directory (default: $AKFLIX_SKIP_FIXTURES or a temp dir) is generated
// when it has no truth.json; that takes a few minutes and needs ffmpeg.
// Fails on any false skip (a marker where there is none, or one reaching more
// than a second into the episode) and on a missed rewatch marker.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dir = resolve(process.argv[2] ?? process.env.AKFLIX_SKIP_FIXTURES ?? join(tmpdir(), "akflix-skip-fixtures"));
if (!existsSync(join(dir, "truth.json"))) {
  console.log(`Generating fixture episodes in ${dir} ...`);
  execFileSync("python3", [join(root, "tests/skip/make_skip_fixtures.py"), dir], { stdio: "inherit" });
}

const result = await build({
  absWorkingDir: root,
  entryPoints: ["tests/skip/fixtureAccuracy.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { runFixtures } = await import(
  "data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64")
);

const started = Date.now();
const results = await runFixtures(dir, false);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
const fmt = (segment) => (segment ? `${segment.start.toFixed(1)}-${segment.end.toFixed(1)}` : "-");
const failures = [];
const errors = { introStart: [], introEnd: [], credits: [] };
let expected = 0;
let found = 0;

for (const { name, pass, truth, markers } of results) {
  const label = `${name} (pass ${pass})`;
  const intro = truth.intro;
  const credits = truth.credits;
  const notes = [];
  if (markers.intro) {
    if (!intro) failures.push(`${label}: intro ${fmt(markers.intro)} where there is none`);
    else {
      // Never skip episode content: the marker must stay inside the true intro.
      if (markers.intro.start < intro[0] - 1 || markers.intro.end > intro[1] + 1) {
        failures.push(`${label}: intro ${fmt(markers.intro)} reaches outside ${intro.join("-")}`);
      }
      errors.introStart.push(markers.intro.start - (truth.intro_clean_from ?? intro[0]));
      errors.introEnd.push(markers.intro.end - intro[1]);
    }
  }
  if (markers.credits) {
    if (!credits) failures.push(`${label}: credits ${fmt(markers.credits)} where there are none`);
    else {
      if (markers.credits.start < credits[0] - 1) {
        failures.push(`${label}: credits start ${markers.credits.start.toFixed(1)} before ${credits[0]}`);
      }
      errors.credits.push(markers.credits.start - credits[0]);
    }
  }
  if (pass === 2) {
    for (const [kind, truthSegment] of [["intro", intro], ["credits", credits]]) {
      if (!truthSegment) continue;
      expected += 1;
      if (markers[kind]) found += 1;
      else {
        failures.push(`${label}: missed the ${kind} on the rewatch`);
        notes.push(`no ${kind}`);
      }
    }
  }
  console.log(
    `${label.padEnd(18)} intro ${fmt(markers.intro).padEnd(12)} truth ${intro ? intro.join("-") : "none"}`.padEnd(64) +
      ` credits ${fmt(markers.credits).padEnd(12)} truth ${credits ? credits.join("-") : "none"}` +
      (markers.recap ? `  recap ${fmt(markers.recap)}` : "") +
      (notes.length ? `  <- ${notes.join(", ")}` : "")
  );
}

const describe = (list) => {
  if (!list.length) return "n/a";
  const abs = list.map(Math.abs).sort((a, b) => a - b);
  return `median ${abs[Math.floor(abs.length / 2)].toFixed(2)} s, worst ${abs[abs.length - 1].toFixed(2)} s`;
};
console.log(`\nRewatch markers found: ${found}/${expected}. False skips: ${failures.filter((f) => f.includes("none") || f.includes("outside") || f.includes("before")).length}.`);
console.log(`Intro start error: ${describe(errors.introStart)}; intro end error: ${describe(errors.introEnd)}; credits start error: ${describe(errors.credits)}.`);
console.log(`Analysis time: ${seconds} s for ${results.length} plays.`);
if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
