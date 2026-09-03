#!/usr/bin/env node
// Counts comment vs code lines per file with a crude per-line classifier (no
// string tokenizing) so the numbers stay comparable to prior audits. Default
// mode scans the committed tree; --added <range> scans only diff-added lines.
// --no-ext-diff is mandatory: this repo routes `git diff` through difftastic,
// and a subprocess without that flag reads an empty string.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const EXCLUDE_PATH = /^(docs|\.claude|tmp|node_modules|dist)\//
const TEST_FILE = /\.test\.|\.spec\.|\.d\.ts$/

export const countLines = text => {
  let comment = 0
  let code = 0
  let inBlock = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (inBlock) {
      comment++
      if (line.includes('*/')) inBlock = false
      continue
    }
    if (line.startsWith('//')) {
      comment++
      continue
    }
    if (line.startsWith('/*')) {
      comment++
      if (!line.includes('*/')) inBlock = true
      continue
    }
    code++
  }
  return { comment, code }
}

export const countAddedLines = diffText => {
  const result = new Map()
  let file = null
  let added = []
  const flush = () => {
    if (!file) return
    const prev = result.get(file) ?? { comment: 0, code: 0 }
    const counted = countLines(added.join('\n'))
    result.set(file, { comment: prev.comment + counted.comment, code: prev.code + counted.code })
    added = []
  }
  for (const raw of diffText.split('\n')) {
    const header = raw.match(/^\+\+\+ b\/(.*)$/)
    if (header) {
      flush()
      file = header[1]
      continue
    }
    if (raw.startsWith('+++')) continue
    if (file && raw.startsWith('+')) added.push(raw.slice(1))
  }
  flush()
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
  printTotal('', totalComment, totalCode, processed)
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

  const perFile = countAddedLines(diff)
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
