// Runs before any store module: gives this worker its own storage and a
// network switch, like a separate physical device.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  },
});
const realFetch = globalThis.fetch.bind(globalThis);
(globalThis as { __offline?: boolean }).__offline = false;
globalThis.fetch = ((...args: Parameters<typeof fetch>) =>
  (globalThis as { __offline?: boolean }).__offline
    ? Promise.reject(new TypeError("fetch failed (device offline)"))
    : realFetch(...args)) as typeof fetch;
export {};
