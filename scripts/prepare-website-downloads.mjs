import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repository = "Akshayan03/akflix";
const platforms = {
  mac: { pattern: /^Akflix_[\d.]+_aarch64\.dmg$/, alias: "Akflix_latest_aarch64.dmg" },
  windows: { pattern: /^Akflix_[\d.]+_x64-setup\.exe$/, alias: "Akflix_latest_x64-setup.exe" },
  windowsMsi: { pattern: /^Akflix_[\d.]+_x64_en-US\.msi$/, alias: "Akflix_latest_x64_en-US.msi" },
};

export function chooseDownloads(releases) {
  const stable = releases.filter((release) => !release.draft && !release.prerelease && /^v\d+\.\d+\.\d+$/.test(release.tag_name))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name, "en", { numeric: true }));
  const selected = {};
  for (const [platform, config] of Object.entries(platforms)) {
    // Keep both Windows installers on the same tested release. A later
    // Mac-only release must not remove the last published Windows download.
    const candidates = platform === "windowsMsi" ? [selected.windows?.release].filter(Boolean) : stable;
    for (const release of candidates) {
      const matches = (asset, pattern) => pattern.test(asset.name)
        && asset.name.startsWith(`Akflix_${release.tag_name.slice(1)}_`) && asset.state === "uploaded";
      if (platform === "windows" && !release.assets.some((asset) => matches(asset, platforms.windowsMsi.pattern))) continue;
      const asset = release.assets.find((candidate) => matches(candidate, config.pattern));
      if (asset) { selected[platform] = { release, asset, alias: config.alias }; break; }
    }
    if (!selected[platform]) throw new Error(`No published ${platform} installer; refusing to deploy broken download buttons`);
  }
  return selected;
}

export function renderMetadata(html, manifest) {
  for (const platform of ["mac", "windows"]) {
    const entry = manifest[platform];
    const size = `${(entry.size / 1024 / 1024).toFixed(1)} MB`;
    html = html.replace(new RegExp(`(data-version="${platform}">)[^<]*`, "g"), `$1${entry.version}`)
      .replace(new RegExp(`(data-size="${platform}">)[^<]*`, "g"), `$1${size}`)
      .replace(new RegExp(`(data-release="${platform}" href=")[^"]*`, "g"), `$1${entry.release}`);
  }
  return html;
}

async function bundleDownloads() {
  const site = resolve(process.argv[2] || "website");
  const output = join(site, "downloads");
  mkdirSync(output, { recursive: true });
  const releases = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases?per_page=100`], { encoding: "utf8" }));
  const selected = chooseDownloads(releases);
  const manifest = {};
  const checksums = [];
  for (const [platform, { release, asset, alias }] of Object.entries(selected)) {
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) throw new Error(`No SHA-256 digest for ${asset.name}`);
    execFileSync("gh", ["release", "download", release.tag_name, "--repo", repository, "--pattern", asset.name, "--dir", output, "--clobber"], { stdio: "inherit" });
    const file = join(output, asset.name);
    if (statSync(file).size !== asset.size) throw new Error(`Incomplete download: ${asset.name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const digest = hash.digest("hex");
    if (`sha256:${digest}` !== asset.digest) throw new Error(`Checksum mismatch: ${asset.name}`);
    renameSync(file, join(output, alias));
    manifest[platform] = { version: release.tag_name.slice(1), size: asset.size, file: alias, original: asset.name, sha256: digest, release: `https://github.com/${repository}/releases/tag/${release.tag_name}` };
    checksums.push(`${digest}  ${alias}`);
    console.log(`Verified ${platform}: ${asset.name} (${asset.size} bytes)`);
  }
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(output, "SHA256SUMS.txt"), checksums.join("\n") + "\n");
  const index = join(site, "index.html");
  writeFileSync(index, renderMetadata(readFileSync(index, "utf8"), manifest));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bundleDownloads();
