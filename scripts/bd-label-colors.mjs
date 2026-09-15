#!/usr/bin/env node
/**
 * Colors and describes the GitHub labels the beads mirror maintains.
 *
 * `bd github sync` mints every machine label (`type::*`, `priority::*`,
 * `status::*`, plus any free-form bead label) at GitHub's default grey with an
 * empty description, and never revisits it. Only states beads actually pushes
 * are listed: `status::open`/`status::closed` never appear (GitHub's own
 * open/closed state carries that), so pre-creating them would be clutter. So this applies the palette AND
 * pre-creates taxonomy values that beads has not pushed yet — a label that
 * already exists is only applied by the sync, not recolored, which is what
 * keeps the fix from decaying the next time someone files the first
 * `type::epic`.
 *
 * The `priority::*` ramp deliberately reuses the hand-maintained P0–P3 colors:
 * the two halves of the dual taxonomy (AGENTS.md) label the same axis and
 * should read as one.
 *
 *   node scripts/bd-label-colors.mjs [--dry-run]
 */

import { spawnSync } from 'node:child_process'

const REPO = 'Stvad/knowledge-medium'

/** name → [color, description] */
const PALETTE = {
  'priority::critical': ['B60205', 'beads mirror: priority 0 — critical (matches P0)'],
  'priority::high': ['D93F0B', 'beads mirror: priority 1 — high (matches P1)'],
  'priority::medium': ['FBCA04', 'beads mirror: priority 2 — medium (matches P2)'],
  'priority::low': ['0E8A16', 'beads mirror: priority 3 — low (matches P3)'],
  'priority::none': ['BFBFBF', 'beads mirror: priority 4 — no priority set'],

  'type::bug': ['D73A4A', 'beads mirror: issue type bug'],
  'type::feature': ['A2EEEF', 'beads mirror: issue type feature'],
  'type::task': ['1D76DB', 'beads mirror: issue type task'],
  'type::chore': ['A98467', 'beads mirror: issue type chore'],
  'type::epic': ['6F42C1', 'beads mirror: issue type epic'],
  'type::decision': ['A371F7', 'beads mirror: issue type decision'],

  'status::in_progress': ['3B5BDB', 'beads mirror: status in progress — claimed by someone'],
  'status::blocked': ['7D1128', 'beads mirror: status blocked — waiting on a dependency'],

  codex: ['1F2328', 'Filed from a Codex agent session'],
  design: ['F2C1E0', 'Design exploration or proposal record'],
  git: ['A8CBD1', 'Git plumbing — worktrees, refs, stash, history'],
  hooks: ['92BCC3', 'Agent or git hook behavior'],
}

const gh = (args) => spawnSync('gh', args, {encoding: 'utf8'})

function existingLabels() {
  const res = gh(['label', 'list', '--repo', REPO, '--limit', '200', '--json', 'name,color,description'])
  if (res.status !== 0) throw new Error(`gh label list failed: ${res.stderr || res.stdout}`)
  return new Map(JSON.parse(res.stdout).map((l) => [l.name, l]))
}

/** Labels whose color or description differs from the palette, plus missing ones. */
function plan(existing, palette = PALETTE) {
  return Object.entries(palette).flatMap(([name, [color, description]]) => {
    const current = existing.get(name)
    if (!current) return [{name, color, description, action: 'create'}]
    if (current.color.toLowerCase() === color.toLowerCase() && current.description === description) return []
    return [{name, color, description, action: 'update', from: current.color}]
  })
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const todo = plan(existingLabels())
  if (todo.length === 0) {
    console.log('beads labels already match the palette')
    return
  }
  for (const {name, color, description, action, from} of todo) {
    console.log(`${action === 'create' ? 'create' : `update (#${from} →)`} #${color}  ${name}`)
    if (dryRun) continue
    const args = ['label', 'create', name, '--repo', REPO, '--color', color, '--description', description]
    if (action === 'update') args.push('--force')
    const res = gh(args)
    if (res.status !== 0) throw new Error(`gh label ${action} ${name} failed: ${res.stderr || res.stdout}`)
  }
  if (dryRun) console.log(`\n(dry run — ${todo.length} label(s) would change)`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
