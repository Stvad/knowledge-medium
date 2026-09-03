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
 * `no-review-provenance`: `PR #N`, review-comment ids, rounds of review,
 * reviewer attributions and `commit <sha>` inside a comment. A BARE sha is
 * not matched: 7–10 hex chars is also a uuid fragment or a colour, and a
 * noisy gate is worse than none — the prose rule covers that form. The rule a comment keeps
 * is timeless; who asked for it and in which round is not, and the audit that
 * produced this rule found the provenance was where stale claims hid.
 * A `#N` issue pointer is allowed; a design citation names a `docs/` path.
 */

// `/**` and `/***` alike — TypeScript reads both as JSDoc.
const isJsDoc = c => c.type === 'Block' && c.value.startsWith('*')
// Blocks that stand on their own, with no node below: TypeScript's declaration
// tags, file/package headers, and legal notices.
// Matched in tag position (the start of a line of the block), not as a word in prose.
const SELF_STANDING_TAG = /(?:^\*?|\n\s*\*?)\s*@(typedef|callback|overload|import|file|fileoverview|module|packageDocumentation|license|preserve|copyright)\b/
const isSelfStanding = c => SELF_STANDING_TAG.test(c.value)
// Only a suppression of THIS rule is skipped: its rationale may name the PR, and
// nothing could suppress the report on the directive itself.
const suppressesThisRule = c => /^\s*eslint-disable(?:-next-line|-line)?\b.*\bno-review-provenance\b/.test(c.value)

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
          if (!isJsDoc(c) || isSelfStanding(c)) continue
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
            const host = src.getNodeByRangeIndex(c.range[0])?.type
            if (host === 'JSXExpressionContainer' || host === 'JSXEmptyExpression') continue
            context.report({loc: c.loc, messageId: 'nothing'})
          }
        }
      },
    }
  },
}

// Every alternative carries an identifier — a number, an id, a sha, or the reviewer's
// name. A bare phrase ("round 2", "review round", "this review") is domain vocabulary
// in this repo (handshakes, SRS reviews) and is never matched.
const PROVENANCE =
  /\b(?:PR|pull request) ?#\d+|\breview comment #?\d{6,}\b|\breview rounds? \d+\b|\brounds? \d+, P[0-4]\b|\bcommit [0-9a-f]{7,}\b|\bCodex (review|on (PR )?#\d|P[0-4]\b)|\breviewer P[0-4]\b/i

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
          if (suppressesThisRule(c)) continue
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
