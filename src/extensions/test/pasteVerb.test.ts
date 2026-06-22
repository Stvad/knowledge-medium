import { describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.ts'
import {
  defaultPasteDecision,
  pasteDecisionVerb,
  type PasteRequest,
} from '../paste.ts'

const request = (over: Partial<PasteRequest>): PasteRequest => ({
  text: '',
  intent: 'split',
  surface: 'editor',
  ...over,
})

describe('defaultPasteDecision', () => {
  it('drops a single-block chord into the current block verbatim', () => {
    expect(defaultPasteDecision(request({intent: 'single-block', text: 'a\nb'})))
      .toEqual({kind: 'single-block'})
  })

  it('splits a plain multiline paste into an outline', () => {
    expect(defaultPasteDecision(request({text: 'a\nb'}))).toEqual({kind: 'split'})
  })

  it('inserts a plain single-line editor paste as a single block (caret insert)', () => {
    expect(defaultPasteDecision(request({text: 'just one line', surface: 'editor'})))
      .toEqual({kind: 'single-block'})
  })

  it('parses a plain single-line shell paste as an outline (no caret)', () => {
    // The shell has no text caret, so single-line falls to the parse path
    // (historical behavior) instead of a verbatim single-block insert.
    expect(defaultPasteDecision(request({text: '- task', surface: 'shell'})))
      .toEqual({kind: 'split'})
  })
})

describe('pasteDecisionVerb', () => {
  it('returns the default decision when nothing is contributed', async () => {
    const runtime = resolveFacetRuntimeSync([])
    await expect(pasteDecisionVerb.run(runtime, request({text: 'a\nb'})))
      .resolves.toEqual({kind: 'split'})
  })

  it('an impl override replaces the decision wholesale', async () => {
    // "Always paste as a single block" preference.
    const runtime = resolveFacetRuntimeSync([
      pasteDecisionVerb.impl(() => ({kind: 'single-block'})),
    ])
    await expect(pasteDecisionVerb.run(runtime, request({text: 'a\nb'})))
      .resolves.toEqual({kind: 'single-block'})
  })

  it('a decorator can rewrite the text and defer to the default (CSV → markdown)', async () => {
    // Pretend a spreadsheet paste arrives as CSV; rewrite it to a markdown
    // list, then let the default decision split it into an outline.
    const csvToMarkdown = (csv: string) =>
      csv.split('\n').map(row => `- ${row.split(',').join(' / ')}`).join('\n')

    const runtime = resolveFacetRuntimeSync([
      pasteDecisionVerb.decorator(next => async req => {
        if (!req.text.includes(',')) return next(req)
        const rewritten = csvToMarkdown(req.text)
        const decision = await next({...req, text: rewritten})
        // Carry the rewritten text on the decision so the editor applies the
        // markdown, not the raw CSV.
        return {...decision, text: rewritten}
      }),
    ])

    const decision = await pasteDecisionVerb.run(runtime, request({text: 'a,b\nc,d'}))
    expect(decision).toEqual({kind: 'split', text: '- a / b\n- c / d'})
  })

  it('falls back to the default decision when a plugin override throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      pasteDecisionVerb.impl(() => {
        throw new Error('buggy paste plugin')
      }),
    ])

    // A buggy override must not break paste: the verb degrades to the
    // historical behavior (multiline plain text → split).
    await expect(pasteDecisionVerb.run(runtime, request({text: 'a\nb'})))
      .resolves.toEqual({kind: 'split'})
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('passes the latched single-block intent through to the default', async () => {
    const runtime = resolveFacetRuntimeSync([])
    await expect(
      pasteDecisionVerb.run(runtime, request({intent: 'single-block', text: 'x'})),
    ).resolves.toEqual({kind: 'single-block'})
  })
})
