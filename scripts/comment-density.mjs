#!/usr/bin/env node
// Counts comment vs code lines with a crude per-line classifier (no string
// tokenizing) so the numbers stay comparable to prior audits. Default mode
// scans the WORKING TREE's tracked files (it measures progress mid-cleanup);
// --added <range> counts only the lines a diff adds, classified against each
// file's postimage so block-comment state survives hunk boundaries.
// --no-ext-diff is mandatory: this repo routes `git diff` through difftastic,
// and a subprocess without that flag reads an empty string.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const EXCLUDE_PATH = /^(docs|\.claude|tmp|node_modules|dist)\//
// Every module extension the toolchain accepts (mirrors the lint config's widest glob).
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs']
const TEST_FILE = /\.test\.|\.spec\.|\.d\.[cm]?ts$/

// 'comment' | 'code' | 'blank' per line.
export const classifyLines = text => {
  let inBlock = false
  return text.split('\n').map(raw => {
    const line = raw.trim()
    if (line === '') return 'blank'
    if (inBlock) {
      if (line.includes('*/')) inBlock = false
      return 'comment'
    }
    if (line.startsWith('//')) return 'comment'
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlock = true
      return 'comment'
    }
    return 'code'
  })
}

export const countLines = text => {
  const counts = { comment: 0, code: 0 }
  for (const kind of classifyLines(text)) if (kind !== 'blank') counts[kind]++
  return counts
}

// Git C-quotes a path holding a quote, backslash or control character whatever
// `core.quotePath` says.
const unquotePath = quoted =>
  quoted.replace(/\\(?:([0-7]{3})|(.))/g, (_, octal, ch) =>
    octal ? String.fromCharCode(parseInt(octal, 8)) : ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', a: '\x07' }[ch] ?? ch))

export const headerPath = line => {
  const quoted = line.match(/^\+\+\+ "b\/(.*)"$/)
  if (quoted) return unquotePath(quoted[1])
  return line.match(/^\+\+\+ b\/(.*)$/)?.[1] ?? null
}

// Per file: the added line numbers (from the hunk headers) and the postimage blob
// hash (from the `index` line) of a unified diff.
export const addedLineNumbers = diffText => {
  const result = new Map()
  let file = null
  let blob = null
  for (const raw of diffText.split('\n')) {
    const index = raw.match(/^index [0-9a-f]+\.\.([0-9a-f]+)/)
    if (index) {
      blob = index[1]
      continue
    }
    if (raw.startsWith('+++ ')) {
      file = headerPath(raw)
      if (file) result.set(file, { lines: [], blob })
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk && file) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let n = start; n < start + count; n++) result.get(file).lines.push(n)
    }
  }
  return result
}

// readPostimage(file, blob) returns the file's text on the diff's "+" side.
export const countAddedLines = (diffText, readPostimage) => {
  const result = new Map()
  for (const [file, { lines: lineNumbers, blob }] of addedLineNumbers(diffText)) {
    if (lineNumbers.length === 0) continue
    const kinds = classifyLines(readPostimage(file, blob))
    const counts = { comment: 0, code: 0 }
    for (const n of lineNumbers) {
      const kind = kinds[n - 1]
      if (kind && kind !== 'blank') counts[kind]++
    }
    result.set(file, counts)
  }
  return result
}

const ratio = (comment, code) => {
  const total = comment + code
  return total === 0 ? 0 : (comment / total) * 100
}

const printTable = (title, rows) => {
  console.log(`\n${title}`)
  console.log('comment\tcode\tratio\tfile')
  for (const { file, comment, code } of rows) {
    console.log(`${comment}\t${code}\t${ratio(comment, code).toFixed(1)}%\t${file}`)
  }
}

const printTotal = (prefix, comment, code, fileCount) => {
  console.log(
    `${prefix}TOTAL over ${fileCount} files: ${comment} comment lines / ${code} code lines = ${ratio(comment, code).toFixed(1)}%`,
  )
}

const runDefault = () => {
  const files = execFileSync('git', ['ls-files', '-z', ...SOURCE_GLOBS], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .filter(f => !TEST_FILE.test(f) && !EXCLUDE_PATH.test(f))

  const rows = []
  let totalComment = 0
  let totalCode = 0
  let processed = 0
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    processed++
    const { comment, code } = countLines(text)
    totalComment += comment
    totalCode += code
    if (comment + code >= 30) rows.push({ file, comment, code })
  }

  const byComment = [...rows].sort((a, b) => b.comment - a.comment).slice(0, 40)
  const byRatio = rows
    .filter(r => r.comment >= 25)
    .sort((a, b) => ratio(b.comment, b.code) - ratio(a.comment, a.code))
    .slice(0, 40)

  printTable('TOP 40 BY COMMENT LINES', byComment)
  printTable('TOP 40 BY RATIO (>= 25 comment lines)', byRatio)
  console.log()
  printTotal('WORKING TREE ', totalComment, totalCode, processed)
}

// The postimage is whatever the diff was computed against: its blob when git has
// the object, else the working tree (an unstaged file's hash names nothing stored).
const readPostimage = (file, blob) => {
  try {
    return execFileSync('git', ['cat-file', '-p', blob], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return readFileSync(file, 'utf8')
  }
}

const runAdded = range => {
  const diff = execFileSync(
    'git',
    [
      '-c', 'core.quotePath=false',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--full-index',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--unified=0',
      '--inter-hunk-context=0',
      range,
      '--',
      ...SOURCE_GLOBS,
      ':!*.test.*',
      ':!*.spec.*',
      ':!*.d.ts',
      ':!*.d.mts',
      ':!*.d.cts',
      ':!docs/*',
      ':!.claude/*',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )

  const perFile = countAddedLines(diff, readPostimage)
  const rows = [...perFile.entries()]
    .map(([file, { comment, code }]) => ({ file, comment, code }))
    .sort((a, b) => b.comment - a.comment)

  let totalComment = 0
  let totalCode = 0
  for (const { comment, code } of rows) {
    totalComment += comment
    totalCode += code
  }

  printTable('ADDED LINES BY FILE', rows)
  console.log()
  printTotal('ADDED ', totalComment, totalCode, rows.length)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const addedIdx = args.indexOf('--added')
  if (addedIdx !== -1) {
    const range = args[addedIdx + 1]
    if (!range) {
      console.error('--added requires a git range argument')
      process.exit(1)
    }
    runAdded(range)
  } else {
    runDefault()
  }
}
