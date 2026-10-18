/**
 * Minimal Cloud Firestore REST client: typed-value codec, get, commit with
 * preconditions, incremental queries and listing. Same calls work against
 * the Firestore emulator.
 */
import type { CloudEnv } from "@/lib/cloud/env";
import { CloudError, requestJson } from "@/lib/cloud/rest";

export type FirestoreValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { stringValue: string }
  | { timestampValue: string }
  | { referenceValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

export type Fields = Record<string, FirestoreValue>;

export interface FirestoreDocument {
  name: string;
  fields?: Fields;
  createTime?: string;
  updateTime?: string;
}

export function toValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { nullValue: null };
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toValue) } };
  if (typeof value === "object") return { mapValue: { fields: toFields(value as Record<string, unknown>) } };
  return { stringValue: String(value) };
}

/** Undefined members are left out, so optional fields never become nulls. */
export function toFields(value: Record<string, unknown>): Fields {
  const fields: Fields = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined) continue;
    fields[key] = toValue(member);
  }
  return fields;
}

export function fromValue(value: FirestoreValue | undefined): unknown {
  if (!value) return undefined;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(fromValue);
  if ("mapValue" in value) return fromFields(value.mapValue.fields ?? {});
  return undefined;
}

export function fromFields(fields: Fields | undefined): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(fields ?? {})) value[key] = fromValue(member);
  return value;
}

/** Firestore document ids may not contain "/" and must avoid "__x__"; keep them URL-safe too. */
export function safeDocId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (char) => `~${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

export interface Write {
  update?: { name: string; fields: Fields };
  delete?: string;
  updateMask?: { fieldPaths: string[] };
  updateTransforms?: { fieldPath: string; setToServerValue: "REQUEST_TIME" }[];
  currentDocument?: { exists: boolean } | { updateTime: string };
}

export interface CommitResult {
  writeResults?: { updateTime?: string }[];
  commitTime: string;
}

export type TokenSource = () => Promise<string | null>;

export class FirestoreClient {
  constructor(private env: CloudEnv, private token: TokenSource) {}

  get root() {
    return `projects/${this.env.projectId}/databases/(default)/documents`;
  }

  path(...segments: string[]) {
    return `${this.root}/${segments.join("/")}`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private url(resource: string) {
    return `${this.env.firestoreBase}/${resource}`;
  }

  async get(name: string): Promise<FirestoreDocument | null> {
    try {
      return await requestJson<FirestoreDocument>(this.url(name), { headers: await this.headers() });
    } catch (reason) {
      if (reason instanceof CloudError && reason.status === 404 && reason.kind === "conflict") return null;
      throw reason;
    }
  }

  async batchGet(names: string[]): Promise<Map<string, FirestoreDocument | null>> {
    const found = new Map<string, FirestoreDocument | null>();
    if (!names.length) return found;
    const rows = await requestJson<{ found?: FirestoreDocument; missing?: string }[]>(this.url(`${this.root}:batchGet`), {
      headers: await this.headers(),
      json: { documents: names },
    });
    for (const row of rows ?? []) {
      if (row.found) found.set(row.found.name, row.found);
      else if (row.missing) found.set(row.missing, null);
    }
    return found;
  }

  async commit(writes: Write[]): Promise<CommitResult> {
    return requestJson<CommitResult>(this.url(`${this.root}:commit`), {
      headers: await this.headers(),
      json: { writes },
    });
  }

  /**
   * Documents in `collection` under `parent` whose `field` (a timestamp)
   * comes after the cursor, oldest first, ordered by (field, name) so a page
   * boundary never skips documents written in the same commit.
   */
  async changedSince(
    parent: string,
    collection: string,
    field: string,
    cursor: { at: string; name: string } | null,
    limit = 300
  ): Promise<FirestoreDocument[]> {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: collection }],
      orderBy: [
        { field: { fieldPath: field }, direction: "ASCENDING" },
        { field: { fieldPath: "__name__" }, direction: "ASCENDING" },
      ],
      limit,
    };
    if (cursor) {
      structuredQuery.startAt = {
        values: [{ timestampValue: cursor.at }, { referenceValue: cursor.name }],
        before: false,
      };
    }
    const rows = await requestJson<{ document?: FirestoreDocument }[]>(this.url(`${parent}:runQuery`), {
      headers: await this.headers(),
      json: { structuredQuery },
    });
    return (rows ?? []).flatMap((row) => (row.document ? [row.document] : []));
  }

  async list(collectionPath: string, pageToken?: string, pageSize = 300): Promise<{ documents: FirestoreDocument[]; nextPageToken?: string }> {
    const params = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) params.set("pageToken", pageToken);
    const value = await requestJson<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(
      `${this.url(collectionPath)}?${params.toString()}`,
      { headers: await this.headers() }
    );
    return { documents: value?.documents ?? [], nextPageToken: value?.nextPageToken };
  }

  async patch(name: string, fields: Fields, fieldPaths: string[], precondition?: Write["currentDocument"]): Promise<FirestoreDocument> {
    const params = new URLSearchParams();
    for (const path of fieldPaths) params.append("updateMask.fieldPaths", path);
    if (precondition && "updateTime" in precondition) params.set("currentDocument.updateTime", precondition.updateTime);
    if (precondition && "exists" in precondition) params.set("currentDocument.exists", String(precondition.exists));
    return requestJson<FirestoreDocument>(`${this.url(name)}?${params.toString()}`, {
      method: "PATCH",
      headers: await this.headers(),
      json: { fields },
    });
  }

  async remove(name: string): Promise<void> {
    await requestJson(this.url(name), { method: "DELETE", headers: await this.headers() });
  }
}
