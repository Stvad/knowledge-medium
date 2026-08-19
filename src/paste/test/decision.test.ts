import { describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.ts'
import type { PasteChordIntent } from '../operations.ts'
import {
  defaultPasteDecision,
  pasteDecisionVerb,
  type PasteCaret,
  type PasteDecision,
  type PasteRequest,
  type PasteSurface,
} from '../decision.ts'

// `editor` requests carry a caret (union invariant); tests that don't care
// about position get a default first-line caret so cases stay terse.
const request = (
  over: {text?: string; intent?: PasteChordIntent; surface?: PasteSurface; caret?: PasteCaret; files?: readonly File[]} = {},
): PasteRequest => {
  const {text = '', intent = 'split', surface = 'editor', caret, files} = over
  return surface === 'shell'
    ? {text, intent, surface, files}
    : {text, intent, surface, files, caret: caret ?? {line: 1, lineCount: 1, from: 0, to: 0}}
}

const pngFile = () => new File([new Uint8Array([1, 2, 3])], 'cat.png', {type: 'image/png'})

describe('defaultPasteDecision', () => {
  it('drops a single-block chord into the current block verbatim', () => {
    expect(defaultPasteDecision(request({intent: 'single-block', text: 'a\nb'})))
      .toEqual({kind: 'single-block'})
  })

  it('honors an explicit single-block decision in the shell (single and multi line)', () => {
    // The shell hardcodes intent 'split', so single-block here only comes
    // from a plugin override — it must be honored verbatim regardless of
    // line count (the cells the surface-aware fix exists to get right).
    expect(defaultPasteDecision(request({intent: 'single-block', surface: 'shell', text: 'one line'})))
      .toEqual({kind: 'single-block'})
    expect(defaultPasteDecision(request({intent: 'single-block', surface: 'shell', text: 'a\nb'})))
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

  it('is text-only — IGNORES files (the "files → media" rule is the attachments decorator, not core)', () => {
    // Moved out of core so it's gated on the attachments plugin's toggle; the core
    // default never produces `media`, so a file paste here decides on its text.
    expect(defaultPasteDecision(request({files: [pngFile()], text: 'a\nb'}))).toEqual({kind: 'split'})
    expect(defaultPasteDecision(request({files: [pngFile()], text: 'x', surface: 'editor'})))
      .toEqual({kind: 'single-block'})
  })
})

describe('pasteDecisionVerb', () => {
  // The renderers resolve the decision with `runSync` (it must decide at/before
  // the synchronous paste `preventDefault`), so the verb is exercised the same
  // way here.
  it('returns the default decision when nothing is contributed', () => {
    const runtime = resolveFacetRuntimeSync([])
    expect(pasteDecisionVerb.runSync(runtime, request({text: 'a\nb'})))
      .toEqual({kind: 'split'})
  })

  it('an impl override replaces the decision wholesale', () => {
    // "Always paste as a single block" preference.
    const runtime = resolveFacetRuntimeSync([
      pasteDecisionVerb.impl(() => ({kind: 'single-block'})),
    ])
    expect(pasteDecisionVerb.runSync(runtime, request({text: 'a\nb'})))
      .toEqual({kind: 'single-block'})
  })

  it('a decorator can rewrite the text and defer to the default (CSV → markdown)', () => {
    // Pretend a spreadsheet paste arrives as CSV; rewrite it to a markdown
    // list, then let the default decision split it into an outline. The
    // decorator is synchronous (the sync-resolution contract).
    const csvToMarkdown = (csv: string) =>
      csv.split('\n').map(row => `- ${row.split(',').join(' / ')}`).join('\n')

    const runtime = resolveFacetRuntimeSync([
      pasteDecisionVerb.decorator(next => req => {
        if (!req.text.includes(',')) return next(req)
        const rewritten = csvToMarkdown(req.text)
        const decision = next({...req, text: rewritten}) as PasteDecision
        // Carry the rewritten text on the decision so the editor applies the
        // markdown, not the raw CSV.
        return {...decision, text: rewritten}
      }),
    ])

    const decision = pasteDecisionVerb.runSync(runtime, request({text: 'a,b\nc,d'}))
    expect(decision).toEqual({kind: 'split', text: '- a / b\n- c / d'})
  })

  it('falls back to the default when an override returns a malformed decision', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Untyped plugins can return undefined (missing return) or a wrong shape;
    // both must degrade to the default rather than reaching the renderers.
    for (const bad of [undefined, {}, {kind: 'nope'}]) {
      const runtime = resolveFacetRuntimeSync([
        pasteDecisionVerb.impl(() => bad as unknown as PasteDecision),
      ])
      expect(pasteDecisionVerb.runSync(runtime, request({text: 'a\nb'})))
        .toEqual({kind: 'split'})
    }
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('falls back to the default decision when a plugin override throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runtime = resolveFacetRuntimeSync([
      pasteDecisionVerb.impl(() => {
        throw new Error('buggy paste plugin')
      }),
    ])

    // A buggy override must not break paste: the verb degrades to the
    // historical behavior (multiline plain text → split).
    expect(pasteDecisionVerb.runSync(runtime, request({text: 'a\nb'})))
      .toEqual({kind: 'split'})
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('falls back to the default when a contribution is async (sync-only contract)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    // These are pure-policy verbs resolved synchronously: an async override
    // can't decide before the paste `preventDefault`, so it's unsupported and
    // degrades to the default rather than silently misbehaving.
    const runtime = resolveFacetRuntimeSync([
      pasteDecisionVerb.impl(async () => ({kind: 'single-block'})),
    ])

    expect(pasteDecisionVerb.runSync(runtime, request({text: 'a\nb'})))
      .toEqual({kind: 'split'})
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('passes the latched single-block intent through to the default', () => {
    const runtime = resolveFacetRuntimeSync([])
    expect(pasteDecisionVerb.runSync(runtime, request({intent: 'single-block', text: 'x'})))
      .toEqual({kind: 'single-block'})
  })

  it('without a media contributor, a file paste is text-only (media capture is plugin-gated)', () => {
    const runtime = resolveFacetRuntimeSync([])
    // Core alone never produces `media`; the attachments decorator (tested in
    // pasteCapture.test.ts) is what turns a file paste into a media capture.
    expect(pasteDecisionVerb.runSync(runtime, request({files: [pngFile()], text: 'a\nb'})))
      .toEqual({kind: 'split'})
  })
})
