/** Minimal Stremio metadata types used by Cinemeta and Torrentio. */

export type StremioMediaType = "movie" | "series";

export interface StremioVideo {
  id: string; // IMDb series id + ":season:episode"
  name?: string;
  title?: string;
  season: number;
  episode: number;
  released?: string;
  overview?: string;
  thumbnail?: string;
}

export interface StremioMeta {
  id: string;
  type: StremioMediaType;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  year?: string;
  imdbRating?: string;
  runtime?: string;
  genres?: string[];
  cast?: string[];
  director?: string[];
  videos?: StremioVideo[];
}

export interface StremioCatalogResponse {
  metas: StremioMeta[];
}

export interface StremioMetaResponse {
  meta: StremioMeta;
}
