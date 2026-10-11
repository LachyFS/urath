import { readFile, writeFile } from "node:fs/promises";

for (const path of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/worker.js",
  "wasm/urath_wasm.js",
  "wasm/urath_wasm.d.ts",
  "README.md",
  "LICENSE",
]) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url)).catch(
    () => {
      throw new Error(
        `Missing ${path}. Run npm run build from the repository root before packing.`,
      );
    },
  );
  if (!bytes.length) throw new Error(`Empty package artifact: ${path}`);
}
const wasm = await readFile(
  new URL("../wasm/urath_wasm_bg.wasm", import.meta.url),
);
if (!wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])))
  throw new Error("Invalid WASM artifact");
// wasm-pack writes a nested .gitignore containing '*'. Override it for npm.
await writeFile(new URL("../wasm/.npmignore", import.meta.url), "");
