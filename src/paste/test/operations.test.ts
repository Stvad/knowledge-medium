// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { isCollapsedProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { captureMediaVerb } from '../captureMediaVerb'
import { pasteDecisionVerb, type PasteDecision, type PasteRequest } from '../decision'
import {
  pasteChordIntent,
  pasteEditModeMultilineText,
  pasteFromClipboard,
  pasteMultilineText,
  planEditModeMultilinePaste,
  planSingleBlockPaste,
  resolvePasteWithMediaCapture,
} from '../operations'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll), reset here per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: sharedDb.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { env.repo.stopSyncObserver() })

const createBlock = async (
  id: string,
  content: string,
  parentId: string | null,
  orderKey: string,
): Promise<void> => {
  await env.repo.tx(tx => tx.create({
    id,
    workspaceId: WS,
    parentId,
    orderKey,
    content,
  }), {scope: ChangeScope.BlockDefault})
}

const childContents = async (parentId: string): Promise<string[]> => {
  const rows = await env.repo.query.children({id: parentId}).load()
  return rows.map(row => row.content)
}

describe('pasteMultilineText', () => {
  it('uses an empty target block as the first pasted root', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('empty', '', 'root', 'a0')
    await createBlock('next', 'Next', 'root', 'a1')

    const pasted = await pasteMultilineText(
      '- Alpha\n  - Detail\n- Beta',
      env.repo.block('empty'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(pasted[0]?.id).toBe('empty')
    expect(env.repo.block('empty').peek()?.content).toBe('Alpha')
    expect(await childContents('empty')).toEqual(['Detail'])
    expect(await childContents('root')).toEqual(['Alpha', 'Beta', 'Next'])
  })

  it('inserts a multi-block paste between tied siblings without losing content (#198)', async () => {
    // The insertion neighbours (the target and its next sibling) share an
    // order_key. The old keysBetween(lower, upper) threw "<key> >= <key>" on the
    // equal bounds, rolling back the whole tx → the pasted blocks vanished.
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('t1', 'T1', 'root', 'a1')
    await createBlock('t2', 'T2', 'root', 'a1')  // tied with t1
    await createBlock('t3', 'T3', 'root', 'a2')

    const pasted = await pasteMultilineText(
      'Alpha\nBeta',
      env.repo.block('t1'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(pasted).toHaveLength(2)
    // The pasted run lands EXACTLY after t1 — between t1 and t2 — breaking the
    // tie (re-keys t2), not past the whole run. No lost content.
    expect(await childContents('root')).toEqual(['T1', 'Alpha', 'Beta', 'T2', 'T3'])
  })

  it('pastes after an expanded target as first visible children', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('parent', 'Parent', 'root', 'a0')
    await createBlock('old-child', 'Old child', 'parent', 'a0')
    await createBlock('sibling', 'Sibling', 'root', 'a1')

    await pasteMultilineText(
      'Pasted\nSecond',
      env.repo.block('parent'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(await childContents('parent')).toEqual(['Pasted', 'Second', 'Old child'])
    expect(await childContents('root')).toEqual(['Parent', 'Sibling'])
  })

  it('reveals a collapsed scope-root target when pasting as its children', async () => {
    // Pasting onto a nested scope root (scopeRootId === target.id) inserts
    // the roots as its children; if it's collapsed they'd be hidden, so the
    // paste must reveal it (same invariant as create-child / move).
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('sr', 'Scope root', 'root', 'a0')
    await createBlock('existing', 'Existing', 'sr', 'a0')
    await env.repo.mutate.setProperty({id: 'sr', schema: isCollapsedProp, value: true})

    await pasteMultilineText('Alpha\nBeta', env.repo.block('sr'), env.repo, {scopeRootId: 'sr'})

    expect(env.repo.block('sr').peek()?.properties[isCollapsedProp.name]).toBe(false)
    expect(await childContents('sr')).toEqual(['Alpha', 'Beta', 'Existing'])
  })

  it('pastes after a collapsed target as a visible sibling', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('parent', 'Parent', 'root', 'a0')
    await createBlock('old-child', 'Old child', 'parent', 'a0')
    await createBlock('sibling', 'Sibling', 'root', 'a1')
    await env.repo.block('parent').set(isCollapsedProp, true)

    await pasteMultilineText(
      'Pasted',
      env.repo.block('parent'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(await childContents('root')).toEqual(['Parent', 'Pasted', 'Sibling'])
    expect(await childContents('parent')).toEqual(['Old child'])
  })

  it('pastes on the zoomed top-level block inside the visible subtree', async () => {
    await createBlock('workspace-root', 'Workspace root', null, 'a0')
    await createBlock('page', 'Page', 'workspace-root', 'a0')
    await createBlock('existing', 'Existing', 'page', 'a0')

    await pasteMultilineText(
      'Pasted',
      env.repo.block('page'),
      env.repo,
      {scopeRootId: 'page'},
    )

    expect(await childContents('workspace-root')).toEqual(['Page'])
    expect(await childContents('page')).toEqual(['Pasted', 'Existing'])
  })

  it('pastes on a parentless top-level block as children instead of no-oping', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('existing', 'Existing', 'root', 'a0')

    await pasteMultilineText(
      'Pasted',
      env.repo.block('root'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(await childContents('root')).toEqual(['Pasted', 'Existing'])
  })

  it('can force sibling placement for range-style paste', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('parent', 'Parent', 'root', 'a0')
    await createBlock('old-child', 'Old child', 'parent', 'a0')
    await createBlock('sibling', 'Sibling', 'root', 'a1')

    await pasteMultilineText(
      'Pasted',
      env.repo.block('parent'),
      env.repo,
      {placement: 'sibling', scopeRootId: 'root'},
    )

    expect(await childContents('root')).toEqual(['Parent', 'Pasted', 'Sibling'])
    expect(await childContents('parent')).toEqual(['Old child'])
  })

  it('pastes the whole text as one block when asSingleBlock is set', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'Target', 'root', 'a0')
    await createBlock('sibling', 'Sibling', 'root', 'a1')

    const pasted = await pasteMultilineText(
      '- Alpha\n- Beta',
      env.repo.block('target'),
      env.repo,
      {scopeRootId: 'root', asSingleBlock: true},
    )

    // No markdown split, no bullet stripping — the whole clipboard becomes
    // one block (the block-shell "single-block" override path).
    expect(pasted).toHaveLength(1)
    expect(pasted[0]?.peek()?.content).toBe('- Alpha\n- Beta')
    expect(await childContents('root')).toEqual(['Target', '- Alpha\n- Beta', 'Sibling'])
  })

  it('absorbs an asSingleBlock paste into a blank target, keeping newlines', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('empty', '', 'root', 'a0')
    await createBlock('next', 'Next', 'root', 'a1')

    const pasted = await pasteMultilineText(
      '- Alpha\n- Beta',
      env.repo.block('empty'),
      env.repo,
      {scopeRootId: 'root', asSingleBlock: true},
    )

    expect(pasted).toHaveLength(1)
    expect(pasted[0]?.id).toBe('empty')
    expect(env.repo.block('empty').peek()?.content).toBe('- Alpha\n- Beta')
    expect(await childContents('root')).toEqual(['- Alpha\n- Beta', 'Next'])
  })

  it('no-ops an asSingleBlock paste of blank text (matches the parse path)', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'Target', 'root', 'a0')

    const pasted = await pasteMultilineText(
      '   \n  ',
      env.repo.block('target'),
      env.repo,
      {scopeRootId: 'root', asSingleBlock: true},
    )

    expect(pasted).toEqual([])
    expect(await childContents('root')).toEqual(['Target'])
  })
})

describe('pasteEditModeMultilineText', () => {
  it('merges the first line at the caret and moves the suffix to the last pasted block', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'hello world', 'root', 'a0')
    await createBlock('next', 'Next', 'root', 'a1')

    const plan = planEditModeMultilinePaste('alpha\nbeta', 'hello world', {
      from: 'hello '.length,
      to: 'hello '.length,
    })
    expect(plan?.targetContent).toBe('hello alpha')

    const result = await pasteEditModeMultilineText(
      plan!,
      env.repo.block('target'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(env.repo.block('target').peek()?.content).toBe('hello alpha')
    expect(await childContents('root')).toEqual(['hello alpha', 'betaworld', 'Next'])
    expect(result?.focusBlock.id).not.toBe('target')
    expect(result?.focusOffset).toBe('beta'.length)
  })

  it('inserts edit-mode paste siblings between tied neighbours without losing content (#198)', async () => {
    // The edited block ties with its next sibling, so the trailing pasted
    // sibling's order_key bounds are equal — the old keysBetween threw and rolled
    // the paste back, dropping the line.
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'hello world', 'root', 'a1')
    await createBlock('tied', 'Tied', 'root', 'a1')  // tied with target
    await createBlock('after', 'After', 'root', 'a2')

    const plan = planEditModeMultilinePaste('alpha\nbeta', 'hello world', {
      from: 'hello '.length,
      to: 'hello '.length,
    })

    const result = await pasteEditModeMultilineText(
      plan!,
      env.repo.block('target'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(env.repo.block('target').peek()?.content).toBe('hello alpha')
    // The new sibling lands EXACTLY after the edited block — between it and the
    // tied 'Tied' sibling (re-keys 'Tied'), not past the whole run.
    expect(await childContents('root')).toEqual(['hello alpha', 'betaworld', 'Tied', 'After'])
    expect(result?.focusBlock.peek()?.content).toBe('betaworld')
  })

  it('parents children of the first pasted root under the edited block', async () => {
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'prefix ', 'root', 'a0')
    await createBlock('next', 'Next', 'root', 'a1')

    const plan = planEditModeMultilinePaste('- Parent\n  - Child\n- Sibling', 'prefix ', {
      from: 'prefix '.length,
      to: 'prefix '.length,
    })

    const result = await pasteEditModeMultilineText(
      plan!,
      env.repo.block('target'),
      env.repo,
      {scopeRootId: 'root'},
    )

    expect(env.repo.block('target').peek()?.content).toBe('prefix Parent')
    expect(await childContents('target')).toEqual(['Child'])
    expect(await childContents('root')).toEqual(['prefix Parent', 'Sibling', 'Next'])
    expect(result?.focusBlock.peek()?.content).toBe('Sibling')
  })

  it('keeps remaining lines visible when editing the zoomed top-level block', async () => {
    await createBlock('workspace-root', 'Workspace root', null, 'a0')
    await createBlock('page', 'Page', 'workspace-root', 'a0')
    await createBlock('existing', 'Existing', 'page', 'a0')

    const plan = planEditModeMultilinePaste(' title\nchild', 'Page', {
      from: 'Page'.length,
      to: 'Page'.length,
    })

    await pasteEditModeMultilineText(
      plan!,
      env.repo.block('page'),
      env.repo,
      {scopeRootId: 'page'},
    )

    expect(await childContents('workspace-root')).toEqual(['Page title'])
    expect(await childContents('page')).toEqual(['child', 'Existing'])
  })
})

describe('pasteChordIntent', () => {
  const key = (over: Partial<KeyboardEvent>): Parameters<typeof pasteChordIntent>[0] => ({
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: 'v', ...over,
  })

  it('classifies Cmd/Ctrl+V as a split paste', () => {
    expect(pasteChordIntent(key({metaKey: true}))).toBe('split')
    expect(pasteChordIntent(key({ctrlKey: true}))).toBe('split')
  })

  it('classifies Cmd/Ctrl+Shift+V as a single-block paste', () => {
    // Browsers report the key as 'V' when Shift is held.
    expect(pasteChordIntent(key({metaKey: true, shiftKey: true, key: 'V'}))).toBe('single-block')
    expect(pasteChordIntent(key({ctrlKey: true, shiftKey: true, key: 'v'}))).toBe('single-block')
  })

  it('ignores non-paste keys and AltGr/Option pastes', () => {
    expect(pasteChordIntent(key({metaKey: true, key: 'c'}))).toBeNull()
    expect(pasteChordIntent(key({key: 'v'}))).toBeNull()
    expect(pasteChordIntent(key({metaKey: true, altKey: true}))).toBeNull()
  })
})

describe('planSingleBlockPaste', () => {
  it('replaces the selected range and places the cursor after the insert', () => {
    const plan = planSingleBlockPaste('AAA', {from: 0, to: 5})
    expect(plan).toEqual({insert: 'AAA', from: 0, to: 5, cursor: 3})
  })

  it('normalizes CRLF/CR to LF so the cursor stays inside the document', () => {
    const plan = planSingleBlockPaste('one\r\ntwo\rthree', {from: 2, to: 2})
    expect(plan.insert).toBe('one\ntwo\nthree')
    expect(plan.cursor).toBe(2 + 'one\ntwo\nthree'.length)
  })
})

describe('pasteFromClipboard (shortcut/programmatic paste)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const stubClipboard = (text: string) =>
    vi.stubGlobal('navigator', {clipboard: {readText: async () => text}})

  it('honors a forced single-block override from the verb (no split)', async () => {
    // The gap Codex flagged: shortcut paste used to bypass pasteDecisionVerb,
    // so a plugin preference like "always paste verbatim" was silently
    // ignored. It must now apply here too.
    stubClipboard('alpha\nbeta')
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'Target', 'root', 'a0')
    env.repo.setRuntimeContributions(pasteDecisionVerb.implFacet, 'test-paste', [
      () => ({kind: 'single-block'}),
    ])

    const pasted = await pasteFromClipboard(env.repo.block('target'), env.repo, {scopeRootId: 'root'})

    expect(pasted).toHaveLength(1)
    expect(pasted[0]?.peek()?.content).toBe('alpha\nbeta')
    expect(await childContents('root')).toEqual(['Target', 'alpha\nbeta'])
  })

  it('applies a verb decorator text rewrite', async () => {
    stubClipboard('one')
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'Target', 'root', 'a0')
    env.repo.setRuntimeContributions(pasteDecisionVerb.decoratorsFacet, 'test-paste', [
      // Synchronous — the decision is resolved via `runSync`.
      next => req => ({...(next(req) as PasteDecision), text: `${req.text}-rewritten`}),
    ])

    const pasted = await pasteFromClipboard(env.repo.block('target'), env.repo, {scopeRootId: 'root'})

    expect(pasted[0]?.peek()?.content).toBe('one-rewritten')
  })

  it('defaults to the historical outline paste with no contributions', async () => {
    stubClipboard('- Alpha\n- Beta')
    await createBlock('root', 'Root', null, 'a0')
    await createBlock('target', 'Target', 'root', 'a0')

    await pasteFromClipboard(env.repo.block('target'), env.repo, {scopeRootId: 'root'})

    // Default shell decision is `split` → markdown parsed, bullets stripped.
    expect(await childContents('root')).toEqual(['Target', 'Alpha', 'Beta'])
  })
})

describe('resolvePasteWithMediaCapture', () => {
  // The attachments plugin's decision rule, inline so this test needs none of the
  // heavy capture deps: a paste carrying file(s) is `media`, else defer to the default.
  const mediaWhenFiles = pasteDecisionVerb.decorator(
    next => req => (req.files && req.files.length > 0 ? { kind: 'media' as const } : next(req)),
  )
  // The helper only forwards files to the (stubbed) capture verb; it never reads them.
  const files = [{} as File]
  const req = (over: Partial<PasteRequest> = {}): PasteRequest => ({
    text: '',
    intent: 'split',
    surface: 'shell',
    ...over,
  })
  const repo = {} as Repo // capture is stubbed; repo is forwarded, not used

  it('passes a non-media paste straight through, no capture', async () => {
    const runtime = resolveFacetRuntimeSync([mediaWhenFiles, captureMediaVerb.impl(() => ({ embeds: ['!((x))'] }))])
    const r = await resolvePasteWithMediaCapture(runtime, req({ text: 'hello' }), { repo, workspaceId: 'ws' })
    expect(r).toEqual({ decision: { kind: 'split' }, text: 'hello' })
  })

  it('captures media, splices the embed text per file, and re-decides as text', async () => {
    const seen: { workspaceId: string }[] = []
    const runtime = resolveFacetRuntimeSync([
      mediaWhenFiles,
      captureMediaVerb.impl(i => {
        seen.push({ workspaceId: i.workspaceId })
        return { embeds: ['!((a))', '!((b))'] }
      }),
    ])
    const r = await resolvePasteWithMediaCapture(runtime, req({ text: 'note', files }), { repo, workspaceId: 'ws-x' })
    expect(seen[0]).toEqual({ workspaceId: 'ws-x' })
    // Re-decided with files stripped → no longer media; clipboard text then one embed/line.
    expect(r?.decision.kind).toBe('split')
    expect(r?.text).toBe('note\n!((a))\n!((b))')
  })

  it('returns null when capture yields no embeds and there is no text', async () => {
    const runtime = resolveFacetRuntimeSync([mediaWhenFiles, captureMediaVerb.impl(() => ({ embeds: [] }))])
    expect(await resolvePasteWithMediaCapture(runtime, req({ text: '', files }), { repo, workspaceId: 'ws' })).toBeNull()
  })

  it('swallows a capture throw — the text half still pastes', async () => {
    const runtime = resolveFacetRuntimeSync([
      mediaWhenFiles,
      captureMediaVerb.impl(() => {
        throw new Error('boom')
      }),
    ])
    const r = await resolvePasteWithMediaCapture(runtime, req({ text: 'kept', files }), { repo, workspaceId: 'ws' })
    expect(r?.text).toBe('kept')
  })
})
