/**
 * Shared fuzzy + recency ranker for page completion and Quick Find.
 *
 * Pipeline (caller-side): pre-filter candidates with a permissive SQL
 * LIKE (typically the prefix-3 of each query token, ANDed), then pass
 * the candidate rows through `rankCandidates` for the final ordering
 * and filtering.
 *
 * Matching: a candidate matches when every query token has either a
 * literal substring match (case-insensitive), a substring at edit
 * distance 1 (tokens of length >= 4 only), or a word-prefix chain —
 * the token cut into consecutive chunks that are each a prefix of a
 * later word in the label ("prodreq" / "prd" → "Product Requirements
 * Document"). Each token contributes its own score (word-start beats
 * substring beats chain beats typo); whole-query exact / prefix /
 * substring matches add a large bonus on top so the "I typed exactly
 * the page name" path stays at the top regardless of recency. Recency
 * is layered last (MRU > recent edit > nothing).
 */

const PREFIX_FILTER_LEN = 3
const TYPO_MIN_TOKEN_LEN = 4

/** Guards on the word-prefix-chain DP below. Both are far above any
 *  real page title / typed query, and exist so a pathological label
 *  (a pasted paragraph that ended up as an alias) can't turn an
 *  autocomplete keystroke into a long scan. */
const CHAIN_MAX_WORDS = 12
const CHAIN_MAX_TOKEN_LEN = 24

const SCORE_FULL_EXACT = 1000
const SCORE_FULL_PREFIX = 500
const SCORE_FULL_SUBSTRING = 200
const SCORE_TOKEN_WORD_START = 30
const SCORE_TOKEN_SUBSTRING = 15
/** Above `SCORE_TOKEN_TYPO`: dropping the spaces out of a title you know
 *  ("prd", "meetnotes") is a deliberate abbreviation, which is stronger
 *  evidence of intent than a one-character slip. */
const SCORE_TOKEN_WORD_CHAIN = 8
const SCORE_TOKEN_TYPO = 4
const SCORE_RECENT_MRU_HEAD = 80
const SCORE_RECENT_MRU_STEP = 6
const SCORE_RECENT_EDIT_HOUR = 25
const SCORE_RECENT_EDIT_DAY = 14
const SCORE_RECENT_EDIT_WEEK = 6
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export interface RankableCandidate {
  /** Stable key for de-duplication. */
  blockId: string
  /** The string actually shown / searched against (alias or content). */
  label: string
  /** Optional updated_at (ms) — boosts recently-edited rows. */
  updatedAt?: number
}

export interface RankInputs<C extends RankableCandidate> {
  candidates: ReadonlyArray<C>
  query: string
  /** Block IDs in MRU order (index 0 = most recent). */
  recentBlockIds?: ReadonlyArray<string>
  /** Current time in ms, defaults to Date.now(). */
  now?: number
}

export interface RankedCandidate<C extends RankableCandidate> {
  candidate: C
  score: number
}

/** Split a query into lowercased tokens by whitespace. */
export const tokenize = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter(token => token.length > 0)

/**
 * Build a LIKE pattern set for SQL pre-filtering. Each token is reduced
 * to its first {@link PREFIX_FILTER_LEN} characters (or its full length
 * if shorter) — enough to discriminate but permissive enough to survive
 * a single-edit typo anywhere after the third character.
 */
export const buildFilterPrefixes = (query: string): string[] => {
  const tokens = tokenize(query)
  const seen = new Set<string>()
  const prefixes: string[] = []
  for (const token of tokens) {
    const prefix = token.slice(0, PREFIX_FILTER_LEN)
    if (seen.has(prefix)) continue
    seen.add(prefix)
    prefixes.push(prefix)
  }
  return prefixes
}

const editDistanceAtMostOne = (a: string, b: string): boolean => {
  if (a === b) return true
  const diff = a.length - b.length
  if (diff > 1 || diff < -1) return false

  if (a.length === b.length) {
    let mismatches = 0
    for (let i = 0; i < a.length; i++) {
      if (a.charCodeAt(i) !== b.charCodeAt(i)) {
        mismatches++
        if (mismatches > 1) return false
      }
    }
    return true
  }

  const shorter = a.length < b.length ? a : b
  const longer = a.length < b.length ? b : a
  let i = 0
  let j = 0
  let edits = 0
  while (i < shorter.length && j < longer.length) {
    if (shorter.charCodeAt(i) === longer.charCodeAt(j)) {
      i++
      j++
    } else {
      edits++
      if (edits > 1) return false
      j++
    }
  }
  return true
}

const hasTypoSubstring = (text: string, token: string): boolean => {
  if (token.length < TYPO_MIN_TOKEN_LEN) return false
  for (let i = 0; i <= text.length; i++) {
    for (const delta of [-1, 0, 1]) {
      const subLen = token.length + delta
      if (subLen <= 0 || i + subLen > text.length) continue
      if (editDistanceAtMostOne(text.slice(i, i + subLen), token)) return true
    }
  }
  return false
}

/** Word runs of a lowercased label — split on whitespace, punctuation
 *  and symbols. Script-agnostic (any `\p{L}` run stays one word), so
 *  "Café Notes" is ["café", "notes"] rather than being cut at the
 *  accent. */
const WORD_SPLIT_RE = /[\s\p{P}\p{S}]+/u

const splitWords = (lowerText: string): string[] =>
  lowerText.split(WORD_SPLIT_RE).filter(word => word.length > 0)

/**
 * Does `token` read as an abbreviation of `words` — can it be cut into
 * consecutive chunks, each a prefix of a later word, in order?
 *
 * This is the shape people type when they drop the spaces out of a page
 * title they already know: run-together prefixes ("meetnotes" →
 * "Meeting Notes", "prodreq" → "Product Requirements …") and
 * initialisms ("prd" → "Product Requirements Document"). Words may be
 * skipped between chunks ("pd" → "Product … Document"); chunk order may
 * not be. Every chunk must start at a word start, which is what keeps
 * this far tighter than a plain subsequence match — "lphabravocharlie"
 * does not match "Alpha Bravo Charlie".
 *
 * Single-word labels bow out: with nothing to chain, the rule would
 * degenerate into "is a prefix of", which `indexOf` already scored.
 *
 * DP over reachable token offsets — `reachable[p] === 1` means "the
 * first p token chars are accounted for by the words seen so far", and
 * each word extends every reachable offset by every prefix length it
 * can absorb. A flat byte array rather than a Set per word: this runs
 * per candidate per keystroke, where the allocation dominated the
 * comparisons it was guarding. O(words × tokenLen × wordLen), bounded
 * by the CHAIN_MAX_* caps.
 */
const matchesWordPrefixChain = (words: readonly string[], token: string): boolean => {
  const target = token.length
  if (target === 0 || words.length < 2) return false
  if (words.length > CHAIN_MAX_WORDS || target > CHAIN_MAX_TOKEN_LEN) return false

  const reachable = new Uint8Array(target + 1)
  reachable[0] = 1
  let highWater = 0
  for (const word of words) {
    // Walk offsets high-to-low so extensions added for THIS word are not
    // themselves extended by it — a chunk comes from one word only.
    for (let start = highWater; start >= 0; start--) {
      if (reachable[start] !== 1) continue
      const maxChunk = Math.min(word.length, target - start)
      for (let k = 1; k <= maxChunk; k++) {
        if (word.charCodeAt(k - 1) !== token.charCodeAt(start + k - 1)) break
        const end = start + k
        if (end === target) return true
        reachable[end] = 1
        if (end > highWater) highWater = end
      }
    }
  }
  return false
}

/** Returns the score for a single token against a lowercased candidate
 *  string, or `null` if the token does not match at all. `words` is a
 *  memoized getter, not an array: the overwhelmingly common case is
 *  every token matching by `indexOf`, and splitting the label is pure
 *  waste there. Deferring it keeps the substring path allocation-free
 *  and the split at most once per candidate. */
const scoreToken = (
  lowerText: string,
  words: () => readonly string[],
  token: string,
): number | null => {
  const idx = lowerText.indexOf(token)
  if (idx === 0) return SCORE_TOKEN_WORD_START
  if (idx > 0) {
    const prev = lowerText.charCodeAt(idx - 1)
    const isWordBoundary = !(
      (prev >= 97 && prev <= 122) || // a-z
      (prev >= 48 && prev <= 57)     // 0-9
    )
    return isWordBoundary ? SCORE_TOKEN_WORD_START : SCORE_TOKEN_SUBSTRING
  }
  // Chain before typo: it scores higher (a deliberate abbreviation beats
  // a slip), so it has to win when a token satisfies both — and it is
  // also the cheaper of the two checks.
  //
  // Necessary condition, checked before splitting the label: a chain's
  // first chunk starts with the token's first character, so that
  // character has to appear somewhere. This is what keeps a query that
  // matches nothing ("zzz") from splitting and running the DP over every
  // candidate the pre-filter returned.
  if (lowerText.includes(token[0]) && matchesWordPrefixChain(words(), token)) {
    return SCORE_TOKEN_WORD_CHAIN
  }
  if (hasTypoSubstring(lowerText, token)) return SCORE_TOKEN_TYPO
  return null
}

const recencyBoost = (
  blockId: string,
  updatedAt: number | undefined,
  recentBlockIds: ReadonlyArray<string> | undefined,
  now: number,
): number => {
  let boost = 0
  if (recentBlockIds) {
    const idx = recentBlockIds.indexOf(blockId)
    if (idx >= 0) {
      const decayed = SCORE_RECENT_MRU_HEAD - idx * SCORE_RECENT_MRU_STEP
      boost += Math.max(decayed, 0)
    }
  }
  if (typeof updatedAt === 'number') {
    const age = now - updatedAt
    if (age <= HOUR_MS) boost += SCORE_RECENT_EDIT_HOUR
    else if (age <= DAY_MS) boost += SCORE_RECENT_EDIT_DAY
    else if (age <= WEEK_MS) boost += SCORE_RECENT_EDIT_WEEK
  }
  return boost
}

/**
 * Score a single candidate label against a query. Returns `null` when
 * the candidate doesn't satisfy every query token. Exported so callers
 * that already have everything (e.g. content snippets) can use it
 * outside the {@link rankCandidates} pipeline.
 */
export const scoreCandidate = (
  label: string,
  query: string,
  queryTokens: string[],
): number | null => {
  if (queryTokens.length === 0) return 0
  const lowerLabel = label.toLowerCase()
  const lowerQuery = query.toLowerCase().trim()
  let words: readonly string[] | null = null
  const wordsOf = () => (words ??= splitWords(lowerLabel))

  let tokenScore = 0
  for (const token of queryTokens) {
    const ts = scoreToken(lowerLabel, wordsOf, token)
    if (ts === null) return null
    tokenScore += ts
  }

  let bonus = 0
  if (lowerQuery.length > 0) {
    if (lowerLabel === lowerQuery) bonus = SCORE_FULL_EXACT
    else if (lowerLabel.startsWith(lowerQuery)) bonus = SCORE_FULL_PREFIX
    else if (lowerLabel.includes(lowerQuery)) bonus = SCORE_FULL_SUBSTRING
  }

  return tokenScore + bonus
}

/**
 * Rank a candidate set against the query, dropping non-matches and
 * sorting by score descending. Ties break on shorter label first, then
 * locale-alphabetical (so the output is deterministic).
 */
export const rankCandidates = <C extends RankableCandidate>({
  candidates,
  query,
  recentBlockIds,
  now = Date.now(),
}: RankInputs<C>): RankedCandidate<C>[] => {
  const tokens = tokenize(query)
  const out: RankedCandidate<C>[] = []
  if (tokens.length === 0) {
    for (const candidate of candidates) {
      out.push({
        candidate,
        score: recencyBoost(candidate.blockId, candidate.updatedAt, recentBlockIds, now),
      })
    }
  } else {
    for (const candidate of candidates) {
      const matchScore = scoreCandidate(candidate.label, query, tokens)
      if (matchScore === null) continue
      const boost = recencyBoost(candidate.blockId, candidate.updatedAt, recentBlockIds, now)
      out.push({candidate, score: matchScore + boost})
    }
  }

  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const la = a.candidate.label.length
    const lb = b.candidate.label.length
    if (la !== lb) return la - lb
    return a.candidate.label.localeCompare(b.candidate.label)
  })
  return out
}
