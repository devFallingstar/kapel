// npm lifecycle "prepare" — runs on local `npm install` in this repo AND when
// npm prepares this package as a git dependency (`npm install -g github:...`).
//
// The git-dependency path cannot build this monorepo: npm prepares git deps in
// a temp clone where workspace links are not reliably set up before prepare
// runs. So the built bundle (dist/kapel.js) is committed to the repo, and this
// script only rebuilds when the bundle is missing (i.e. never for end-user
// installs, which is exactly what makes `npm install -g <git url>` work).
// Contributors rebuild explicitly with `npm run build && npm run bundle`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bundle = `${root}dist/kapel.js`;

if (existsSync(bundle)) {
  console.log("kapel: dist/kapel.js present — skipping build during prepare");
  process.exit(0);
}

for (const script of ["build", "bundle"]) {
  const result = spawnSync("npm", ["run", script], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
