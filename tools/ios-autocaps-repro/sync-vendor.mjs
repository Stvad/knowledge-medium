// Copies the exact @codemirror/view + @codemirror/state ESM dist (and their leaf
// deps) out of the project's node_modules into ./vendor so index.html can load
// real CodeMirror over a plain importmap — no bundler, no CDN. vendor/ is
// gitignored; run this once after `yarn install` (or in a fresh checkout).
//
//   node tools/ios-autocaps-repro/sync-vendor.mjs
import { createRequire } from "node:module"
import { copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const OUT = join(dirname(fileURLToPath(import.meta.url)), "vendor")
mkdirSync(OUT, { recursive: true })

// The packages set `exports`, so `require.resolve('pkg/package.json')` is blocked.
// Resolve the package's entry file instead, then walk up to its root.
function pkgRoot(spec) {
  let d = dirname(require.resolve(spec))
  while (!existsSync(join(d, "package.json"))) d = dirname(d)
  return d
}

// [bare specifier, subpath of its ESM entry, output filename]
const FILES = [
  ["@codemirror/view", "dist/index.js", "codemirror-view.js"],
  ["@codemirror/state", "dist/index.js", "codemirror-state.js"],
  ["crelt", "index.js", "crelt.js"],
  ["style-mod", "src/style-mod.js", "style-mod.js"],
  ["w3c-keyname", "index.js", "w3c-keyname.js"],
  ["@marijn/find-cluster-break", "src/index.js", "find-cluster-break.js"],
]

for (const [spec, sub, out] of FILES) {
  const root = pkgRoot(spec)
  copyFileSync(join(root, sub), join(OUT, out))
  const ver = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
  console.log(`vendored ${out.padEnd(22)} <- ${spec}@${ver}`)
}
console.log(`\nDone -> ${OUT}`)
