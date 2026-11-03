// The importmap index.html declares — the specifiers a runtime-loaded extension
// can import. Read from the page itself so tests check the map the app ships.
import {readFileSync} from 'node:fs'
import path from 'node:path'

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

const indexHtml = readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8')
const importMapJson = indexHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
if (!importMapJson) throw new Error('index.html has no <script type="importmap">')

export const pageImports: Readonly<Record<string, string>> =
  (JSON.parse(importMapJson) as {imports: Record<string, string>}).imports
