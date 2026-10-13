// Monochrome design system, brand assets and honest UI copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import tailwindConfig from "../tailwind.config.js";
import logo from "../src/brand/logo.json";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Every colour literal in a string, with whether it is a neutral grey. */
function colourLiterals(text: string): { literal: string; neutral: boolean }[] {
  const found: { literal: string; neutral: boolean }[] = [];
  for (const m of text.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    found.push({ literal: m[0], neutral: r === g && g === b });
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)) {
    found.push({ literal: m[0], neutral: m[1] === m[2] && m[2] === m[3] });
  }
  for (const m of text.matchAll(/hsla?\(\s*[\d.]+(?:deg)?[\s,]+([\d.]+)%/g)) {
    found.push({ literal: m[0], neutral: Number(m[1]) === 0 });
  }
  return found;
}

const CHROMATIC_CLASS =
  /\b(?:bg|text|border|from|via|to|ring|fill|stroke|shadow|outline|decoration|accent|caret|divide|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|stone)-\d/;

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

test("every theme colour token is a neutral grey", () => {
  const colors = tailwindConfig.theme.extend.colors as Record<string, unknown>;
  const values = JSON.stringify(colors);
  const literals = colourLiterals(values);
  assert.ok(literals.length > 15, "expected the neutral ramp and surfaces");
  assert.deepEqual(literals.filter((l) => !l.neutral), []);
});

test("neutral text tokens keep WCAG contrast on every surface", () => {
  const zinc = tailwindConfig.theme.extend.colors.zinc as Record<string, string>;
  for (const surface of ["#000000", "#0c0c0c", "#121212", "#171717", "#1c1c1c", "#272727"]) {
    assert.ok(contrast(zinc["300"], surface) >= 9.5, `zinc-300 on ${surface}`);
    assert.ok(contrast(zinc["400"], surface) >= 6.5, `zinc-400 on ${surface}`);
    assert.ok(contrast(zinc["500"], surface) >= 4.5, `zinc-500 on ${surface}`);
  }
  for (const surface of ["#000000", "#0c0c0c", "#121212", "#171717", "#1c1c1c"]) {
    assert.ok(contrast(zinc["600"], surface) >= 3, `zinc-600 on ${surface}`);
  }
  // Primary buttons and error panels are black on white.
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
});

test("interface source uses only neutral colours", () => {
  const offenders: string[] = [];
  for (const path of [...sourceFiles("src"), "index.html"]) {
    const text = read(path);
    if (CHROMATIC_CLASS.test(text)) offenders.push(`${path}: ${text.match(CHROMATIC_CLASS)![0]}`);
    for (const l of colourLiterals(text)) if (!l.neutral) offenders.push(`${path}: ${l.literal}`);
  }
  assert.deepEqual(offenders, []);
});

test("small text never uses the 3:1-only grey", () => {
  const offenders = sourceFiles("src")
    .filter((path) => path.endsWith(".tsx"))
    .flatMap((path) => (read(path).match(/text-zinc-(?:600|700)\b/g) ?? []).map((m) => `${path}: ${m}`));
  assert.deepEqual(offenders, []);
});

/** Decodes an 8-bit, non-interlaced RGB/RGBA PNG. */
function decodePng(path: string) {
  const data = readFileSync(join(root, path));
  assert.equal(data.subarray(1, 4).toString(), "PNG", `${path} is not a PNG`);
  let offset = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString();
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, `${path}: 8-bit expected`);
      colorType = body[9];
      assert.equal(body[12], 0, `${path}: non-interlaced expected`);
    }
    if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(channels, `${path}: RGB or RGBA expected, got colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = left + up - upLeft;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - upLeft)
          ? left
          : Math.abs(p - up) <= Math.abs(p - upLeft) ? up : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      pixels[y * stride + x] = (value + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function assertGreyscale(path: string) {
  const { channels, pixels } = decodePng(path);
  for (let i = 0; i < pixels.length; i += channels) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 2, `${path}: colour pixel ${r},${g},${b} at ${i / channels}`);
  }
}

test("app icons and the menu-bar template are monochrome renders of the new mark", () => {
  const icon = decodePng("assets/icon.png");
  assert.deepEqual([icon.width, icon.height, icon.channels], [1024, 1024, 4]);
  for (const path of ["assets/icon.png", "src-tauri/icons/128x128.png", "src-tauri/icons/32x32.png", "website/icon.png"]) {
    assertGreyscale(path);
  }
  const tray = decodePng("src-tauri/icons/tray-template.png");
  assert.deepEqual([tray.width, tray.height, tray.channels], [44, 44, 4]);
  // A template image: black glyph on transparency (macOS supplies the tint).
  for (let i = 0; i < tray.pixels.length; i += 4) {
    if (tray.pixels[i + 3] > 0) assert.ok(tray.pixels[i] < 16, "template pixels must be black");
  }
});

test("the in-app logo uses the same geometry as the brand SVGs", () => {
  const svgPath = (file: string) => read(`assets/brand/${file}`).match(/ d="([^"]+)"/)![1];
  assert.equal(svgPath("akflix-mark.svg"), logo.mark.path);
  assert.equal(svgPath("akflix-wordmark.svg"), logo.wordmark.path);
  assert.ok(read("src-tauri/icons/app-icon.svg").includes(logo.mark.path), "app-icon.svg must embed the mark");
  assert.ok(read("src/components/Brand.tsx").includes('from "@/brand/logo.json"'));
  // The old gold prism mark is gone everywhere.
  for (const path of ["src/components/Brand.tsx", "src-tauri/icons/app-icon.svg", "website/index.html"]) {
    assert.doesNotMatch(read(path), /D6B25E|akflix-prism|AK<span>FLIX/i, path);
  }
});

test("one tray icon: no menu-less tray from the config, template glyph on macOS", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.app.trayIcon, undefined);
  const rust = read("src-tauri/src/lib.rs");
  assert.match(rust, /include_image!\("icons\/tray-template\.png"\)\)\s*\.icon_as_template\(true\)/);
  assert.equal((rust.match(/TrayIconBuilder::with_id/g) ?? []).length, 2, "one builder per platform branch");
});

test("settings shows the shipped version, not a stale constant", () => {
  const settings = read("src/pages/Settings.tsx");
  assert.match(settings, /import \{ version as packageVersion \} from "\.\.\/\.\.\/package\.json"/);
  assert.doesNotMatch(settings, /APP_VERSION = "\d/);
});

test("stream status never claims connectivity it did not measure", () => {
  assert.doesNotMatch(read("src/components/StreamController.tsx"), /Wi-Fi ready/);
});

test("desktop motion stays short and Reduce Motion still turns it off", () => {
  const css = read("src/index.css");
  const ms = (name: string) => Number(css.match(new RegExp(`--ak-${name}:\\s*(\\d+)ms`))?.[1]);
  for (const token of ["dur-fast", "dur", "dur-slow"]) {
    assert.ok(ms(token) > 0 && ms(token) <= 300, `--ak-${token} must be at most 300ms`);
  }
  // The one longer entrance (hero backdrops) never delays input: it is a
  // single opacity/scale settle, not a looping or click-gating animation.
  const backdrop = Number(css.match(/\.ak-backdrop-in\s*\{\s*animation:\s*ak-backdrop-in (\d+)ms/)?.[1]);
  assert.ok(backdrop > 0 && backdrop <= 600, "hero backdrop settle must be at most 600ms");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms !important/);
  assert.match(read("src/App.tsx"), /<MotionConfig reducedMotion="user">/);
});
