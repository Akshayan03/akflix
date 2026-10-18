// Runs the real detector (src/lib/skip) over the generated seasons
// (tests/skip/make_skip_fixtures.py), reading audio and chapters with ffmpeg
// the way the Mac app does, and reports every marker against the truth.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeSkipMarkers } from "../../src/lib/skip/detector";
import { SkipMemory, type SkipStorage } from "../../src/lib/skip/cache";
import { parseFfmetadataChapters, type SkipMarkers } from "../../src/lib/skip/markers";

export interface Truth {
  season: string;
  episode: number;
  duration: number;
  intro: [number, number] | null;
  recap?: [number, number];
  credits: [number, number] | null;
  chapters?: boolean;
}

export interface EpisodeResult {
  name: string;
  pass: number;
  truth: Truth;
  markers: SkipMarkers;
  /** First time (seconds into the analysis) an intro marker was published. */
  introFoundAfterAudio?: number;
}

export class MemoryStorage implements SkipStorage {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

function ffmpeg(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", ...args]);
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

export async function readPcm(file: string, start: number, seconds: number): Promise<Int16Array> {
  const out = await ffmpeg([
    ...(start > 0 ? ["-ss", start.toFixed(3)] : []),
    "-i", file, "-t", seconds.toFixed(3), "-vn", "-sn", "-dn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
  ]);
  return new Int16Array(out.buffer, out.byteOffset, Math.floor(out.length / 2)).slice();
}

export async function readChapters(file: string) {
  const out = await ffmpeg(["-i", file, "-f", "ffmetadata", "pipe:1"]);
  return parseFfmetadataChapters(out.toString("utf8"));
}

/** Plays every season in episode order (twice: the second pass is a rewatch,
 * so episode 1 can use what episode 2 taught). */
export async function runFixtures(dir: string, log = false): Promise<EpisodeResult[]> {
  const truth = JSON.parse(readFileSync(join(dir, "truth.json"), "utf8")) as Record<string, Truth>;
  const names = Object.keys(truth).sort((a, b) =>
    truth[a].season.localeCompare(truth[b].season) || truth[a].episode - truth[b].episode
  );
  const results: EpisodeResult[] = [];
  const storage = new MemoryStorage();
  const memory = new SkipMemory(storage);
  for (const pass of [1, 2]) {
    for (const name of names) {
      const t = truth[name];
      const file = join(dir, name);
      let readSeconds = 0;
      let introFoundAfterAudio: number | undefined;
      const controller = new AbortController();
      const markers = await analyzeSkipMarkers({
        identity: { show: `fixture-${t.season}`, season: 1, episode: t.episode, source: name },
        duration: () => t.duration,
        memory,
        adapter: {
          chapters: () => readChapters(file),
          pcm: async (start, seconds) => {
            const pcm = await readPcm(file, start, seconds);
            readSeconds += pcm.length / 8000;
            return pcm;
          },
        },
        onMarkers: (found) => {
          if (found.intro && introFoundAfterAudio === undefined) introFoundAfterAudio = readSeconds;
        },
        signal: controller.signal,
        log: log ? (message) => console.log(`  [${name} pass ${pass}] ${message}`) : undefined,
      });
      results.push({ name, pass, truth: t, markers, introFoundAfterAudio });
    }
  }
  return results;
}

if (process.argv[1]?.endsWith("fixtureAccuracy.ts") || process.env.AKFLIX_SKIP_REPORT) {
  const dir = process.env.AKFLIX_SKIP_FIXTURES ?? process.argv[2];
  runFixtures(dir, true).then((results) => {
    for (const r of results) {
      const fmt = (s?: { start: number; end: number }) => (s ? `${s.start.toFixed(2)}-${s.end.toFixed(2)}` : "-");
      console.log(
        `${r.name} pass ${r.pass}: intro ${fmt(r.markers.intro)} (truth ${r.truth.intro?.map((v) => v.toFixed(2)).join("-") ?? "none"})` +
          ` credits ${fmt(r.markers.credits)} (truth ${r.truth.credits?.map((v) => v.toFixed(2)).join("-") ?? "none"})` +
          (r.markers.recap ? ` recap ${fmt(r.markers.recap)}` : "")
      );
    }
  });
}
