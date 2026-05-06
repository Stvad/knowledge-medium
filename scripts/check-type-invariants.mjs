import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const srcDir = path.join(root, 'src')

const allowedFiles = new Set([
  'src/data/properties.ts',
  'src/data/repo.ts',
])

const isSourceFile = (file) => /\.(ts|tsx|js|jsx)$/.test(file)
const isTestFile = (file) =>
  /(^|\/)test\//.test(file) || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file)

const patterns = [
  {
    name: 'direct tx.setProperty(..., typesProp, ...) write',
    regex: /tx\.setProperty\s*\([\s\S]{0,250}?typesProp/g,
  },
  {
    name: 'direct [typesProp.name] object write',
    regex: /\[typesProp\.name\]\s*:/g,
  },
  {
    name: 'direct typesProp indexed assignment',
    regex: /\[typesProp\.name\]\s*=/g,
  },
]

const walk = async (dir) => {
  const entries = await readdir(dir, {withFileTypes: true})
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walk(fullPath))
    } else if (entry.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}

const lineNumberAt = (source, index) => source.slice(0, index).split('\n').length

const violations = []
for (const filePath of await walk(srcDir)) {
  const relative = path.relative(root, filePath)
  if (allowedFiles.has(relative) || isTestFile(relative)) continue

  const source = await readFile(filePath, 'utf8')
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern.regex)) {
      const index = match.index ?? 0
      const lineNumber = lineNumberAt(source, index)
      const line = source.split('\n')[lineNumber - 1]?.trim() ?? ''
      violations.push({relative, lineNumber, pattern: pattern.name, line})
    }
  }
}

if (violations.length > 0) {
  console.error('Direct typesProp writes bypass Repo type invariants.')
  console.error('Use repo.addType/addTypeInTx, or addBlockTypeToProperties only in raw BlockData planning.')
  for (const violation of violations) {
    console.error(
      `${violation.relative}:${violation.lineNumber}: ${violation.pattern}: ${violation.line}`,
    )
  }
  process.exit(1)
}

console.log('type invariant checks passed')
