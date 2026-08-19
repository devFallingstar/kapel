// Bundles the CLI (apps/cli plus every @agent/* workspace package) into a
// single ESM file, dist/kapel.js, which the root package exposes as the
// `kapel` bin. Third-party npm packages stay external — they are declared in
// the root package's dependencies and installed normally, which keeps the
// native better-sqlite3 module and ink/react resolution intact.
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));

await build({
  entryPoints: [`${root}apps/cli/dist/index.js`],
  outfile: `${root}dist/kapel.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Workspace @agent/* code is bundled in (it is never published); everything
  // installable from the registry stays external.
  external: [
    "better-sqlite3",
    "commander",
    "drizzle-orm",
    "drizzle-orm/*",
    "ink",
    "react",
    "react/*",
    "yaml",
    "zod",
  ],
  banner: {
    // The entry file's own hashbang is hoisted above this banner by esbuild.
    // A createRequire shim keeps any CommonJS externals (better-sqlite3)
    // loadable from the ESM bundle.
    js: [
      'import { createRequire as __kapelCreateRequire } from "node:module";',
      "const require = __kapelCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

chmodSync(`${root}dist/kapel.js`, 0o755);
console.log("bundled dist/kapel.js");
