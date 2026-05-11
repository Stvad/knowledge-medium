/// <reference types="node" />
// Smoke test: feeds the user's actual Roam export through the pure
// planner. The fixture is local-only — the test silently no-ops when
// it isn't present so CI doesn't depend on it.
//
// Vitest sets process.cwd() to the project (worktree) root. The first
// path is for users who place the fixture inside the worktree, the
// second covers git-worktree setups that share fixtures with the main
// repo checkout.

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { planImport } from '../plan'
import type { RoamExport } from '../types'

const cwd = process.cwd()
const candidatePaths = [
  resolve(cwd, 'tmp/export-pages 2.json'),
  resolve(cwd, '../../../tmp/export-pages 2.json'),
]

const SAMPLE_PATH = candidatePaths.find(p => existsSync(p)) ?? candidatePaths[0]

describe('planImport — real Roam export sample', () => {
  it('plans without throwing and reports sane counts', () => {
    if (!existsSync(SAMPLE_PATH)) {
      // Fixture is local-only; skip when missing.
      return
    }

    const raw = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as RoamExport
    expect(Array.isArray(raw)).toBe(true)
    expect(raw.length).toBeGreaterThan(0)

    const plan = planImport(raw, {
      workspaceId: '00000000-0000-4000-8000-000000000000',
      currentUserId: '11111111-1111-4111-8111-111111111111',
    })

    expect(plan.pages.length).toBe(raw.length)
    // The export has both daily and non-daily pages — make sure at
    // least one of each is recognised.
    expect(plan.pages.some(p => p.isDaily)).toBe(true)
    expect(plan.pages.some(p => !p.isDaily)).toBe(true)

    // Descendants in post-order (leaves first) means the last block in
    // a page's subtree is its first-level child after reverse.
    expect(plan.descendants.length).toBeGreaterThan(0)

    // No descendant should reference a parent that isn't in our id map
    // — broken parent-chain would bite at write time.
    const allIds = new Set([
      ...plan.pages.map(p => p.blockId),
      ...plan.descendants.map(d => d.data.id),
    ])
    for (const desc of plan.descendants) {
      if (!desc.data.parentId) continue
      expect(allIds.has(desc.data.parentId)).toBe(true)
    }
  })
})
