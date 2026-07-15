/**
 * Unified fetch layer.
 *
 * - Inside the Tauri desktop app we use @tauri-apps/plugin-http, whose fetch
 *   is performed by the Rust process and is therefore NOT subject to browser
 *   CORS restrictions. This lets us talk to Jellyfin / qBittorrent / Prowlarr
 *   on any host without server-side CORS config.
 * - In a plain browser (`npm run dev`) we fall back to window.fetch and rely
 *   on the Vite dev proxies configured in vite.config.ts.
 */

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type FetchFn = typeof globalThis.fetch;

let tauriFetch: FetchFn | null = null;

/** Lazily import the Tauri HTTP plugin so the web build doesn't need it at runtime. */
async function getFetch(): Promise<FetchFn> {
  if (!isTauri()) return globalThis.fetch.bind(globalThis);
  if (!tauriFetch) {
    const mod = await import("@tauri-apps/plugin-http");
    tauriFetch = mod.fetch as unknown as FetchFn;
  }
  return tauriFetch;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
}

export async function httpRaw(url: string, opts: HttpOptions = {}): Promise<Response> {
  const f = await getFetch();
  return f(url, {
    method: opts.method ?? "GET",
    headers: opts.headers,
    body: opts.body,
    signal: opts.signal,
  });
}

/** JSON helper that throws a readable error on non-2xx responses. */
export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const res = await httpRaw(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}\n${text.slice(0, 300)}`);
  }
  // Some endpoints (e.g. Jellyfin session reports) return 204 No Content.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Strip trailing slashes so URL joining stays predictable. */
export const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, "");
