import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const result = await build({
  absWorkingDir: root,
  entryPoints: ["tests/regressions.test.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "native-test-bridge",
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "bridge", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: "export const invoke = (...args) => globalThis.__testInvoke(...args);",
      }));
    },
  }],
});
await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
