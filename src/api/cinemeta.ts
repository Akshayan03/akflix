/** Cinemeta — Stremio-compatible movie/series catalog and metadata. */

import { httpJson } from "@/lib/http";
import type {
  StremioCatalogResponse,
  StremioMediaType,
  StremioMeta,
  StremioMetaResponse,
} from "@/types/stremio";

const BASE_URL = "https://v3-cinemeta.strem.io";

export class CinemetaClient {
  async catalog(
    type: StremioMediaType,
    catalog = "top",
    extra?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<StremioMeta[]> {
    const suffix = extra
      ? `/${Object.entries(extra)
          .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
          .join("&")}`
      : "";
    const response = await httpJson<StremioCatalogResponse>(
      `${BASE_URL}/catalog/${type}/${catalog}${suffix}.json`,
      { signal }
    );
    return response.metas ?? [];
  }

  async search(query: string, signal?: AbortSignal): Promise<StremioMeta[]> {
    const [movies, series] = await Promise.all([
      this.catalog("movie", "top", { search: query }, signal),
      this.catalog("series", "top", { search: query }, signal),
    ]);
    return [...movies, ...series];
  }

  async meta(
    type: StremioMediaType,
    id: string,
    signal?: AbortSignal
  ): Promise<StremioMeta> {
    const response = await httpJson<StremioMetaResponse>(
      `${BASE_URL}/meta/${type}/${encodeURIComponent(id)}.json`,
      { signal }
    );
    return response.meta;
  }
}

export const cinemeta = new CinemetaClient();
