/**
 * Jellyfin API client.
 *
 * All library, auth, metadata, playback and progress operations go through
 * here. Endpoints follow the official API: https://api.jellyfin.org/
 *
 * Auth model: Jellyfin uses an `Authorization: MediaBrowser ...` header that
 * identifies the client/device and (after login) carries the access token.
 */

import { httpJson, httpRaw, normalizeUrl } from "@/lib/http";
import { getDeviceId, secondsToTicks } from "@/lib/utils";
import type {
  AuthResponse,
  BaseItem,
  ItemsResult,
  JellyfinUser,
  MediaSource,
  PlaybackInfoResponse,
  ServerProfile,
} from "@/types/jellyfin";

const CLIENT = "Akflix";
const VERSION = "1.0.6";

function authHeader(token?: string): string {
  const parts = [
    `Client="${CLIENT}"`,
    `Device="Desktop"`,
    `DeviceId="${getDeviceId()}"`,
    `Version="${VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

export class JellyfinClient {
  constructor(
    public serverUrl: string,
    private token?: string,
    public userId?: string
  ) {
    this.serverUrl = normalizeUrl(serverUrl);
  }

  static fromProfile(p: ServerProfile): JellyfinClient {
    return new JellyfinClient(p.serverUrl, p.accessToken, p.userId);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: authHeader(this.token),
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return httpJson<T>(`${this.serverUrl}${path}`, { headers: this.headers(), signal });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return httpJson<T>(`${this.serverUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private delete_(path: string): Promise<void> {
    return httpJson<void>(`${this.serverUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }

  // ─────────────────────────────── Auth ───────────────────────────────

  /** Ping the server without auth — used to validate a server URL. */
  static async pingServer(serverUrl: string): Promise<{ ServerName?: string; Version?: string }> {
    return httpJson(`${normalizeUrl(serverUrl)}/System/Info/Public`);
  }

  /** Username/password login. Returns token + user. */
  static async authenticate(
    serverUrl: string,
    username: string,
    password: string
  ): Promise<AuthResponse> {
    return httpJson<AuthResponse>(`${normalizeUrl(serverUrl)}/Users/AuthenticateByName`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ Username: username, Pw: password }),
    });
  }

  /** Users with `EnableAutoLogin` visible on the login screen (profile picker). */
  static async publicUsers(serverUrl: string): Promise<JellyfinUser[]> {
    return httpJson<JellyfinUser[]>(`${normalizeUrl(serverUrl)}/Users/Public`, {
      headers: { Authorization: authHeader() },
    });
  }

  async me(): Promise<JellyfinUser> {
    return this.get<JellyfinUser>("/Users/Me");
  }

  // ────────────────────────────── Library ─────────────────────────────

  /** Top-level library views (Movies, Shows, ...). */
  async views(): Promise<ItemsResult> {
    return this.get<ItemsResult>(`/Users/${this.userId}/Views`);
  }

  /** Continue Watching row. */
  async resumeItems(limit = 20): Promise<ItemsResult> {
    const q = new URLSearchParams({
      Limit: String(limit),
      Recursive: "true",
      Fields: "Overview,Genres,MediaSources",
      MediaTypes: "Video",
      EnableImageTypes: "Primary,Backdrop,Thumb",
    });
    return this.get<ItemsResult>(`/Users/${this.userId}/Items/Resume?${q}`);
  }

  /** Next episodes to watch for series in progress. */
  async nextUp(limit = 20): Promise<ItemsResult> {
    const q = new URLSearchParams({
      UserId: this.userId!,
      Limit: String(limit),
      Fields: "Overview,Genres",
      EnableImageTypes: "Primary,Backdrop,Thumb",
    });
    return this.get<ItemsResult>(`/Shows/NextUp?${q}`);
  }

  /** Recently added in a library view. */
  async latest(parentId: string, limit = 20): Promise<BaseItem[]> {
    const q = new URLSearchParams({
      ParentId: parentId,
      Limit: String(limit),
      Fields: "Overview,Genres",
      EnableImageTypes: "Primary,Backdrop,Thumb",
    });
    return this.get<BaseItem[]>(`/Users/${this.userId}/Items/Latest?${q}`);
  }

  /** Generic items query. */
  async items(params: Record<string, string>): Promise<ItemsResult> {
    const q = new URLSearchParams({
      Recursive: "true",
      Fields: "Overview,Genres",
      EnableImageTypes: "Primary,Backdrop,Thumb",
      ...params,
    });
    return this.get<ItemsResult>(`/Users/${this.userId}/Items?${q}`);
  }

  /** Items for a genre row, sorted by community rating. */
  async byGenre(genre: string, types = "Movie,Series", limit = 20): Promise<ItemsResult> {
    return this.items({
      Genres: genre,
      IncludeItemTypes: types,
      SortBy: "CommunityRating",
      SortOrder: "Descending",
      Limit: String(limit),
    });
  }

  /** "My List" — favorited items. */
  async favorites(limit = 40): Promise<ItemsResult> {
    return this.items({
      Filters: "IsFavorite",
      IncludeItemTypes: "Movie,Series",
      SortBy: "DateCreated",
      SortOrder: "Descending",
      Limit: String(limit),
    });
  }

  async item(itemId: string): Promise<BaseItem> {
    return this.get<BaseItem>(`/Users/${this.userId}/Items/${itemId}`);
  }

  async seasons(seriesId: string): Promise<ItemsResult> {
    return this.get<ItemsResult>(`/Shows/${seriesId}/Seasons?UserId=${this.userId}`);
  }

  async episodes(seriesId: string, seasonId: string): Promise<ItemsResult> {
    const q = new URLSearchParams({
      UserId: this.userId!,
      SeasonId: seasonId,
      Fields: "Overview",
    });
    return this.get<ItemsResult>(`/Shows/${seriesId}/Episodes?${q}`);
  }

  async search(term: string, limit = 30, signal?: AbortSignal): Promise<ItemsResult> {
    const q = new URLSearchParams({
      searchTerm: term,
      Recursive: "true",
      IncludeItemTypes: "Movie,Series,Episode",
      Fields: "Overview,Genres,Path,MediaSources,DateCreated",
      Limit: String(limit),
      EnableImageTypes: "Primary,Backdrop,Thumb",
    });
    return httpJson<ItemsResult>(`${this.serverUrl}/Users/${this.userId}/Items?${q}`, {
      headers: this.headers(),
      signal,
    });
  }

  async setFavorite(itemId: string, favorite: boolean): Promise<void> {
    if (favorite) await this.post(`/Users/${this.userId}/FavoriteItems/${itemId}`);
    else await this.delete_(`/Users/${this.userId}/FavoriteItems/${itemId}`);
  }

  /** Ask the server to rescan libraries (used after a torrent finishes). */
  async refreshLibrary(): Promise<void> {
    await httpRaw(`${this.serverUrl}/Library/Refresh`, {
      method: "POST",
      headers: this.headers(),
    });
  }

  // ────────────────────────────── Images ──────────────────────────────

  imageUrl(
    item: BaseItem,
    type: "Primary" | "Backdrop" | "Thumb" = "Primary",
    maxWidth = 400
  ): string | null {
    // Episodes often have no backdrop of their own — fall back to the series'.
    if (type === "Backdrop") {
      if (item.BackdropImageTags?.length) {
        return `${this.serverUrl}/Items/${item.Id}/Images/Backdrop/0?maxWidth=${maxWidth}&tag=${item.BackdropImageTags[0]}&quality=90`;
      }
      if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
        return `${this.serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop/0?maxWidth=${maxWidth}&tag=${item.ParentBackdropImageTags[0]}&quality=90`;
      }
      return null;
    }
    const tag = item.ImageTags?.[type];
    if (!tag) {
      // Episodes: fall back to series poster for Primary.
      if (type === "Primary" && item.SeriesId) {
        return `${this.serverUrl}/Items/${item.SeriesId}/Images/Primary?maxWidth=${maxWidth}&quality=90`;
      }
      return null;
    }
    return `${this.serverUrl}/Items/${item.Id}/Images/${type}?maxWidth=${maxWidth}&tag=${tag}&quality=90`;
  }

  // ────────────────────────────── Playback ────────────────────────────

  /**
   * Negotiate playback. We send a simple device profile: direct-play common
   * containers, otherwise ask the server for an HLS transcode (h264/aac).
   */
  async playbackInfo(itemId: string, startSeconds = 0): Promise<PlaybackInfoResponse> {
    const body = {
      UserId: this.userId,
      StartTimeTicks: secondsToTicks(startSeconds),
      AutoOpenLiveStream: true,
      DeviceProfile: {
        MaxStreamingBitrate: 120_000_000,
        DirectPlayProfiles: [
          { Container: "mp4,m4v,webm", Type: "Video" },
          { Container: "mp3,aac,flac,webma", Type: "Audio" },
        ],
        TranscodingProfiles: [
          {
            Container: "ts",
            Type: "Video",
            VideoCodec: "h264",
            AudioCodec: "aac",
            Protocol: "hls",
            Context: "Streaming",
            MaxAudioChannels: "2",
          },
        ],
        SubtitleProfiles: [
          { Format: "vtt", Method: "External" },
          { Format: "srt", Method: "External" },
        ],
      },
    };
    return this.post<PlaybackInfoResponse>(
      `/Items/${itemId}/PlaybackInfo?UserId=${this.userId}`,
      body
    );
  }

  /**
   * Resolve the final URL the <video> element should play.
   * Returns { url, isHls } — HLS URLs are fed through hls.js.
   */
  streamUrl(itemId: string, source: MediaSource, playSessionId: string) {
    if (source.SupportsDirectStream || source.SupportsDirectPlay) {
      const q = new URLSearchParams({
        Static: "true",
        mediaSourceId: source.Id,
        deviceId: getDeviceId(),
        api_key: this.token ?? "",
        PlaySessionId: playSessionId,
      });
      return {
        url: `${this.serverUrl}/Videos/${itemId}/stream.${source.Container ?? "mp4"}?${q}`,
        isHls: false,
      };
    }
    // Server-provided transcode URL (already contains the session params).
    return { url: `${this.serverUrl}${source.TranscodingUrl}`, isHls: true };
  }

  /** External subtitle delivery URL (WebVTT so the browser can render it). */
  subtitleUrl(itemId: string, mediaSourceId: string, streamIndex: number): string {
    return `${this.serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${streamIndex}/0/Stream.vtt?api_key=${this.token}`;
  }

  // ─────────────────────── Progress reporting ─────────────────────────
  // These keep "Continue Watching" in sync across every Jellyfin client.

  async reportStart(itemId: string, mediaSourceId: string, playSessionId: string) {
    await this.post("/Sessions/Playing", {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      CanSeek: true,
    });
  }

  async reportProgress(
    itemId: string,
    mediaSourceId: string,
    playSessionId: string,
    positionSeconds: number,
    isPaused: boolean
  ) {
    await this.post("/Sessions/Playing/Progress", {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      PositionTicks: secondsToTicks(positionSeconds),
      IsPaused: isPaused,
      CanSeek: true,
    });
  }

  async reportStopped(
    itemId: string,
    mediaSourceId: string,
    playSessionId: string,
    positionSeconds: number
  ) {
    await this.post("/Sessions/Playing/Stopped", {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      PositionTicks: secondsToTicks(positionSeconds),
    });
  }
}
