/**
 * Catalogue artwork at the size it is drawn.
 *
 * Cinemeta lists every title with metahub's 300 px poster, which a 3× iPhone
 * stretched four times over across the Home spotlight. metahub, TMDB, the
 * episode stills and Jellyfin all serve a ladder of widths, so artwork is
 * picked by drawn width × devicePixelRatio: cards get a srcset (the browser
 * picks), heroes measure their box and ask for one exact size.
 */

export interface ArtworkSize {
  url: string;
  /** Pixel width of the image at this size. */
  width: number;
}

export interface ArtworkOptions {
  /** Also offer the full-size source (2000 px posters). Heroes only, never cards. */
  original?: boolean;
}

type Ladder = (url: string, options: ArtworkOptions) => ArtworkSize[] | null;

// https://images.metahub.space/{poster|background|logo}/{size}/{imdb id}/img
const METAHUB = /^(https?:\/\/images\.metahub\.space\/)(poster|background|logo)\/[a-z]+(\/.+)$/i;
const METAHUB_WIDTHS: Record<string, [string, number][]> = {
  poster: [["small", 300], ["medium", 500], ["large", 780]],
  // background/large is the same 1920 px file as medium.
  background: [["small", 480], ["medium", 1920]],
  logo: [["medium", 800]],
};

const metahub: Ladder = (url, { original }) => {
  const match = METAHUB.exec(url);
  if (!match) return null;
  const [, host, kind, rest] = match;
  const sizes = METAHUB_WIDTHS[kind.toLowerCase()].map(([size, width]) => ({ url: `${host}${kind}/${size}${rest}`, width }));
  // metahub answers a size it doesn't scale to with the 2000 px source poster.
  if (original && kind.toLowerCase() === "poster") sizes.push({ url: `${host}${kind}/original${rest}`, width: 2000 });
  return sizes;
};

// https://episodes.metahub.space/{imdb id}/{season}/{episode}/w780.jpg
const EPISODE = /^(https?:\/\/episodes\.metahub\.space\/.+\/)(?:w\d+|original)(\.jpg)$/i;
const episodeStill: Ladder = (url) => {
  const match = EPISODE.exec(url);
  if (!match) return null;
  return [300, 780, 1280].map((width) => ({ url: `${match[1]}w${width}${match[2]}`, width }));
};

// https://image.tmdb.org/t/p/{size}/{file}; TMDB serves every width for posters and backdrops.
const TMDB = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)(?:w\d+|original)(\/.+)$/i;
const tmdb: Ladder = (url) => {
  const match = TMDB.exec(url);
  if (!match) return null;
  return [185, 342, 500, 780, 1280].map((width) => ({ url: `${match[1]}w${width}${match[2]}`, width }));
};

// Jellyfin scales on request: /Items/{id}/Images/{type}?maxWidth=400&tag=…
const jellyfin: Ladder = (url) => {
  if (!/\/Items\/[^/]+\/Images\//.test(url) || !/[?&]maxWidth=\d+/.test(url)) return null;
  return [300, 500, 780, 1280, 1920].map((width) => ({ url: url.replace(/([?&]maxWidth=)\d+/, `$1${width}`), width }));
};

const LADDERS = [metahub, episodeStill, tmdb, jellyfin];

/** Every width this image comes in, smallest first; empty when its host has only one. */
export function artworkSizes(url: string | null | undefined, options: ArtworkOptions = {}): ArtworkSize[] {
  if (!url) return [];
  for (const ladder of LADDERS) {
    const sizes = ladder(url, options);
    if (sizes) return sizes;
  }
  return [];
}

/** The smallest size at least `pixels` wide (else the biggest); other URLs as they are. */
export function artworkAt(url: string, pixels: number, options: ArtworkOptions = {}): string {
  const sizes = artworkSizes(url, options);
  if (!sizes.length) return url;
  return (sizes.find((size) => size.width >= pixels) ?? sizes[sizes.length - 1]).url;
}

/** `srcset` for an image drawn at a CSS `sizes` width: the browser takes the size that covers it on this screen. */
export function artworkSrcSet(url: string | null | undefined): string | undefined {
  const sizes = artworkSizes(url);
  return sizes.length > 1 ? sizes.map((size) => `${size.url} ${size.width}w`).join(", ") : undefined;
}

/** CSS `sizes` of the catalogue's cards (their Tailwind widths). */
export const CARD_SIZES = {
  poster: "(min-width: 1536px) 204px, (min-width: 1280px) 184px, (min-width: 768px) 164px, 138px",
  landscape: "(min-width: 1280px) 340px, (min-width: 768px) 300px, (min-width: 415px) 340px, 82vw",
  /** .ak-poster-grid columns are 148–168 px and grow to fill the row (≤ 2 per iPhone screen). */
  grid: "(min-width: 768px) 240px, 50vw",
} as const;

export interface HeroPick {
  /** The size this screen needs. */
  url: string;
  /** The next best size, if `url` fails to load. */
  fallback?: string;
  /** The smallest size, shown until `url` has loaded. */
  preview?: string;
  landscape: boolean;
}

const POSTER_ASPECT = 2 / 3;
const BACKDROP_ASPECT = 16 / 9;

/**
 * Artwork for a box drawn with object-fit: cover. A landscape box takes the
 * backdrop and a portrait box the poster (either one when that's all there
 * is), at the width the cover scale needs at this pixel ratio.
 */
export function heroArtwork(
  poster: string | null | undefined,
  backdrop: string | null | undefined,
  box: { width: number; height: number },
  pixelRatio: number
): HeroPick | null {
  const landscape = box.width >= box.height;
  const useBackdrop = landscape ? !!backdrop : !poster;
  const source = useBackdrop ? backdrop : poster;
  if (!source || box.width <= 0 || box.height <= 0) return null;
  const aspect = useBackdrop ? BACKDROP_ASPECT : POSTER_ASPECT;
  const pixels = Math.ceil(Math.max(box.width, box.height * aspect) * Math.min(Math.max(pixelRatio, 1), 3));
  const url = artworkAt(source, pixels, { original: true });
  const fallback = artworkAt(source, pixels);
  const smallest = artworkSizes(source)[0]?.url;
  return {
    url,
    fallback: fallback !== url ? fallback : undefined,
    preview: smallest && smallest !== url ? smallest : undefined,
    landscape,
  };
}
