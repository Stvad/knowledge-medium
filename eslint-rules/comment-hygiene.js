/**
 * Comment hygiene — the two comment defects a linter can see.
 *
 * `no-invisible-jsdoc`: a `/** … *​/` block TypeScript will never show. TS
 * attaches the LAST `/**` block before a node and discards any earlier one,
 * so a doc stacked on another doc, or left before `}` / end of file, is text
 * nobody's editor renders — and the stacked case usually means the surviving
 * doc describes the wrong symbol. A blank line or a `//` line between a doc
 * and its declaration does NOT detach it (verified against the TS API), so
 * those are deliberately not flagged.
 *
 * `no-review-provenance`: `PR #N`, review-comment ids, round numbers,
 * reviewer attributions and commit shas inside a comment. The rule a comment keeps
 * is timeless; who asked for it and in which round is not, and the audit that
 * produced this rule found the provenance was where stale claims hid.
 * A `#N` issue pointer is allowed; a design citation names a `docs/` path.
 */

const isJsDoc = c => c.type === 'Block' && c.value.startsWith('*') && !c.value.startsWith('**')
const isDirective = c => /^\s*(eslint-|@ts-|prettier-|biome-)/.test(c.value)

const noInvisibleJsdoc = {
  meta: {
    type: 'problem',
    docs: {description: 'Disallow JSDoc blocks TypeScript attaches to nothing.'},
    messages: {
      shadowed:
        'This JSDoc is followed by another JSDoc before any declaration, so TypeScript attaches only the later one and no editor shows this text. Merge it into the next block, or make it a plain `/* */` or `//` comment.',
      nothing:
        'This JSDoc is followed by a closing bracket or the end of the file, so it documents nothing. Delete it, or move it onto the member it describes.',
    },
    schema: [],
  },
  create(context) {
    const src = context.sourceCode
    return {
      Program() {
        for (const c of src.getAllComments()) {
          if (!isJsDoc(c)) continue
          let next = src.getTokenAfter(c, {includeComments: true})
          let shadowed = false
          while (next && (next.type === 'Line' || next.type === 'Block')) {
            if (isJsDoc(next)) shadowed = true
            next = src.getTokenAfter(next, {includeComments: true})
          }
          if (shadowed) {
            context.report({loc: c.loc, messageId: 'shadowed'})
            continue
          }
          if (!next || next.value === '}' || next.value === ')' || next.value === ']') {
            // `{/** … */}` in JSX is a comment inside an expression container, not a doc.
            const prev = src.getTokenBefore(c)
            if (next?.value === '}' && prev?.value === '{') continue
            context.report({loc: c.loc, messageId: 'nothing'})
          }
        }
      },
    }
  },
}

const PROVENANCE =
  /\bPR ?#\d+|\breview comment \d{6,}\b|\breview rounds?\b|\brounds? \d\b|\bcommit [0-9a-f]{7,}\b|\bCodex (review|on (PR )?#\d)|\breviewer P[0-4]\b/i

const noReviewProvenance = {
  meta: {
    type: 'suggestion',
    docs: {description: 'Disallow PR ids, review rounds, reviewer attributions and commit shas in comments.'},
    messages: {
      provenance:
        'Review provenance in a comment ("{{match}}"): the PR, the round and the reviewer belong on the PR thread; the comment keeps the rule. A `#N` issue pointer is fine, and a design citation is a docs/ path (`docs/properties-as-blocks-migration.html §7`, not `PR #288 §7`).',
    },
    schema: [],
  },
  create(context) {
    const src = context.sourceCode
    return {
      Program() {
        for (const c of src.getAllComments()) {
          if (isDirective(c)) continue
          const match = PROVENANCE.exec(c.value)
          if (match) context.report({loc: c.loc, messageId: 'provenance', data: {match: match[0]}})
        }
      },
    }
  },
}

export default {
  rules: {
    'no-invisible-jsdoc': noInvisibleJsdoc,
    'no-review-provenance': noReviewProvenance,
  },
}
