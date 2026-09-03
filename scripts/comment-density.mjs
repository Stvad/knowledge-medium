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
const TEST_FILE = /\.test\.|\.spec\.|\.d\.ts$/

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
    if (line.startsWith('/*')) {
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

// Added line numbers per file, from the hunk headers of a unified diff.
export const addedLineNumbers = diffText => {
  const result = new Map()
  let file = null
  for (const raw of diffText.split('\n')) {
    const header = raw.match(/^\+\+\+ b\/(.*)$/)
    if (header) {
      file = header[1]
      result.set(file, [])
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk && file) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let n = start; n < start + count; n++) result.get(file).push(n)
    }
  }
  return result
}

// readPostimage(file) returns the file's text on the diff's "+" side.
export const countAddedLines = (diffText, readPostimage) => {
  const result = new Map()
  for (const [file, lineNumbers] of addedLineNumbers(diffText)) {
    if (lineNumbers.length === 0) continue
    const kinds = classifyLines(readPostimage(file))
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
  const files = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs', '*.js'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
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

// The "+" side of `A..B` / `A...B` is B; a bare rev diffs against the working tree.
const postimageReader = range => {
  const rev = /\.\.\.?(.*)$/.exec(range)?.[1]
  if (rev === undefined) return file => readFileSync(file, 'utf8')
  return file => execFileSync('git', ['show', `${rev || 'HEAD'}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const runAdded = range => {
  const diff = execFileSync(
    'git',
    [
      'diff',
      '--no-ext-diff',
      '--unified=0',
      range,
      '--',
      '*.ts',
      '*.tsx',
      '*.mjs',
      '*.js',
      ':!*.test.*',
      ':!*.spec.*',
      ':!*.d.ts',
      ':!docs/*',
      ':!.claude/*',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )

  const perFile = countAddedLines(diff, postimageReader(range))
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
