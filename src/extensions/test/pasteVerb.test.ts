import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.ts'
import {
  defaultPasteDecision,
  pasteDecisionVerb,
  type PasteDecision,
  type PasteRequest,
} from '../paste.ts'

const request = (over: Partial<PasteRequest>): PasteRequest => ({
  text: '',
  intent: 'split',
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

  it('leaves a plain single-line paste to the editor', () => {
    expect(defaultPasteDecision(request({text: 'just one line'}))).toEqual({kind: 'native'})
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
        const decision = await next({...req, text: csvToMarkdown(req.text)})
        // Carry the rewritten text forward on the decision so the editor
        // splits the markdown, not the raw CSV.
        return decision.kind === 'native'
          ? decision
          : ({...decision, text: csvToMarkdown(req.text)} as PasteDecision)
      }),
    ])

    const decision = await pasteDecisionVerb.run(runtime, request({text: 'a,b\nc,d'}))
    expect(decision).toEqual({kind: 'split', text: '- a / b\n- c / d'})
  })

  it('passes the latched single-block intent through to the default', async () => {
    const runtime = resolveFacetRuntimeSync([])
    await expect(
      pasteDecisionVerb.run(runtime, request({intent: 'single-block', text: 'x'})),
    ).resolves.toEqual({kind: 'single-block'})
  })
})
