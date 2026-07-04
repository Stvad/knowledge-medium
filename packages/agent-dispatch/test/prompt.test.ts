import {describe, expect, it} from 'vitest'
import {renderMentionPrompt, renderQueryPrompt} from '../src/prompt'

const context = {
  content: '[[claude]] summarize this',
  subtree: '- [[claude]] summarize this\n  - item A\n  - item B',
  ancestors: ['Projects', 'Weekly review'],
  blockId: 'b-1',
  deepLink: 'https://app/#/b-1',
  watcherName: 'claude-mentions',
}

describe('renderMentionPrompt', () => {
  it('renders the default template with subtree + ancestors', () => {
    const prompt = renderMentionPrompt(undefined, context)
    expect(prompt).toContain('[[claude]] summarize this')
    expect(prompt).toContain('item B')
    expect(prompt).toContain('- Projects\n- Weekly review')
    expect(prompt).toContain('Block id: b-1')
    // Loop guard must ship in the default prompt.
    expect(prompt).toContain('Never write the literal token [[claude]]')
  })

  it('renders custom templates and leaves unknown placeholders intact', () => {
    const prompt = renderMentionPrompt('Task {{blockId}} in {{unknown}}', context)
    expect(prompt).toBe('Task b-1 in {{unknown}}')
  })

  it('labels top-level mentions instead of an empty ancestors section', () => {
    const prompt = renderMentionPrompt(undefined, {...context, ancestors: []})
    expect(prompt).toContain('(top level)')
  })

  it('appends the outline nudge only when splitReply is set', () => {
    expect(renderMentionPrompt(undefined, context)).not.toContain('block hierarchy')
    const withSplit = renderMentionPrompt(undefined, {...context, splitReply: true})
    expect(withSplit).toContain('block hierarchy')
    // The nudge rides on custom templates too (splitReply is orthogonal).
    expect(renderMentionPrompt('Do {{blockId}}', {...context, splitReply: true}))
      .toContain('block hierarchy')
  })
})

describe('renderQueryPrompt', () => {
  it('embeds new rows as JSON', () => {
    const prompt = renderQueryPrompt(undefined, {
      watcherName: 'inbox-growth',
      newRows: [{id: 'x', content: 'new item'}],
    })
    expect(prompt).toContain('inbox-growth')
    expect(prompt).toContain('"content": "new item"')
  })
})
