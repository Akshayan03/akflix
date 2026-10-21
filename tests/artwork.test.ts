// Artwork sizes: sharp on a Retina Mac (and a 3× iPhone) without loading full-size art for cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARD_SIZES, artworkAt, artworkSizes, artworkSrcSet, heroArtwork } from "../src/lib/artwork";

const POSTER = "https://images.metahub.space/poster/small/tt14452776/img";
const BACKDROP = "https://images.metahub.space/background/medium/tt14452776/img";
const widths = (url: string, original = false) => artworkSizes(url, { original }).map((size) => size.width);

test("metahub posters and backdrops come in their real widths, whatever size the catalogue listed", () => {
  assert.deepEqual(widths(POSTER), [300, 500, 780]);
  assert.deepEqual(widths("https://images.metahub.space/poster/medium/tt14452776/img"), [300, 500, 780]);
  assert.deepEqual(widths(POSTER, true), [300, 500, 780, 2000]);
  assert.deepEqual(widths(BACKDROP), [480, 1920]);
  assert.deepEqual(widths(BACKDROP, true), [480, 1920], "no bigger backdrop exists");
  assert.equal(artworkAt(POSTER, 400), "https://images.metahub.space/poster/medium/tt14452776/img");
  assert.equal(artworkAt(POSTER, 1218, { original: true }), "https://images.metahub.space/poster/original/tt14452776/img");
  assert.equal(artworkAt(POSTER, 1218), "https://images.metahub.space/poster/large/tt14452776/img", "cards never get the original");
});

test("episode stills, TMDB and Jellyfin images scale; other URLs are left alone", () => {
  assert.equal(artworkAt("https://episodes.metahub.space/tt14452776/1/1/w780.jpg", 276), "https://episodes.metahub.space/tt14452776/1/1/w300.jpg");
  assert.equal(artworkAt("https://image.tmdb.org/t/p/w185/abc.jpg", 414), "https://image.tmdb.org/t/p/w500/abc.jpg");
  assert.equal(
    artworkAt("http://nas:8096/Items/42/Images/Primary?maxWidth=400&quality=90", 1218),
    "http://nas:8096/Items/42/Images/Primary?maxWidth=1280&quality=90"
  );
  for (const url of ["https://example.com/poster.jpg", "asset://localhost/poster.jpg", ""]) {
    assert.deepEqual(artworkSizes(url), []);
    assert.equal(artworkSrcSet(url), undefined);
  }
  assert.equal(artworkAt("https://example.com/poster.jpg", 2000), "https://example.com/poster.jpg");
});

// What a browser does with srcset + sizes: the smallest candidate covering the drawn width × pixel ratio.
const chosen = (url: string, cssWidth: number, ratio: number) => {
  const candidates = artworkSrcSet(url)!.split(", ").map((entry) => {
    const [src, width] = entry.split(" ");
    return { src, width: parseInt(width, 10) };
  });
  return (candidates.find((candidate) => candidate.width >= cssWidth * ratio) ?? candidates[candidates.length - 1]).width;
};

test("cards load at least their drawn size on a 2× Mac and never the full-size source", () => {
  assert.equal(chosen(POSTER, 204, 2), 500, "2xl row poster: 204 pt × 2 = 408 px");
  assert.equal(chosen(POSTER, 164, 2), 500, "md row poster");
  assert.equal(chosen(POSTER, 240, 2), 500, "poster grid");
  assert.equal(chosen(BACKDROP, 340, 2), 1920, "landscape card");
  assert.ok(!artworkSrcSet(POSTER)!.includes("/original/"));
  assert.ok(CARD_SIZES.poster.includes("204px") && CARD_SIZES.landscape.includes("340px"));
});

test("the iPhone Home spotlight is sharp at 3×: the poster at ≥ 1218 px, with the small one as a preview", () => {
  // iPhone 16 Pro Max: 430 pt wide, 12 pt margins, ~600 pt tall.
  const pick = heroArtwork(POSTER, BACKDROP, { width: 406, height: 600 }, 3)!;
  assert.equal(pick.landscape, false);
  assert.equal(pick.url, "https://images.metahub.space/poster/original/tt14452776/img");
  assert.equal(pick.fallback, "https://images.metahub.space/poster/large/tt14452776/img");
  assert.equal(pick.preview, POSTER);
  // iPhone SE (2×): 351 × 510 pt needs 702 px.
  assert.equal(heroArtwork(POSTER, BACKDROP, { width: 351, height: 510 }, 2)!.url, "https://images.metahub.space/poster/large/tt14452776/img");
});

test("a landscape hero takes the backdrop; either one when only one exists", () => {
  const wide = heroArtwork(POSTER, BACKDROP, { width: 398, height: 274 }, 3)!;
  assert.equal(wide.landscape, true);
  assert.equal(wide.url, BACKDROP);
  assert.equal(wide.preview, "https://images.metahub.space/background/small/tt14452776/img");
  assert.equal(heroArtwork(POSTER, undefined, { width: 1440, height: 800 }, 2)!.url, "https://images.metahub.space/poster/original/tt14452776/img");
  assert.equal(heroArtwork(undefined, BACKDROP, { width: 406, height: 600 }, 3)!.url, BACKDROP);
  assert.equal(heroArtwork(undefined, undefined, { width: 406, height: 600 }, 3), null);
  assert.equal(heroArtwork(POSTER, BACKDROP, { width: 0, height: 0 }, 3), null);
});

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("every card asks for its drawn size", () => {
  for (const file of ["src/components/DiscoverCard.tsx", "src/components/MediaCard.tsx", "src/components/PickThree.tsx", "src/pages/DiscoverDetails.tsx"]) {
    assert.match(read(file), /sizes=/, file);
  }
  assert.equal(read("src/components/DiscoverCard.tsx").match(/sizes=\{/g)?.length, 2, "caption and plain cards");
  assert.match(read("src/components/DiscoverCard.tsx"), /loading="lazy"/);
});
