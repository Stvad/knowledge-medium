// The importmap index.html declares — the specifiers a runtime-loaded extension
// can import. Read from the page itself so tests check the map the app ships.
import {readPageImports} from '../../vite-plugins/extensionImportManifest'
import path from 'node:path'

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

export const pageImports = readPageImports(REPO_ROOT)
