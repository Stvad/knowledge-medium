import { describe, it, expect } from 'vitest'
import {
  buildFilterPrefixes,
  rankCandidates,
  scoreCandidate,
  tokenize,
  type RankableCandidate,
} from '../fuzzyRank'

const NOW = 1_700_000_000_000

const candidate = (
  blockId: string,
  label: string,
  updatedAt?: number,
): RankableCandidate => ({blockId, label, updatedAt})

const labels = (results: ReadonlyArray<{candidate: RankableCandidate}>) =>
  results.map(result => result.candidate.label)

describe('tokenize', () => {
  it('splits on whitespace and lowercases', () => {
    expect(tokenize('Quick Brown Fox')).toEqual(['quick', 'brown', 'fox'])
  })

  it('drops empty tokens from collapsed whitespace', () => {
    expect(tokenize('  hello   world  ')).toEqual(['hello', 'world'])
  })

  it('returns [] for an empty query', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('buildFilterPrefixes', () => {
  it('takes leading 3 chars of each token', () => {
    expect(buildFilterPrefixes('Review Skills')).toEqual(['rev', 'ski'])
  })

  it('keeps short tokens whole', () => {
    expect(buildFilterPrefixes('a bb ccc')).toEqual(['a', 'bb', 'ccc'])
  })

  it('de-dupes prefixes (so the same SQL clause is not added twice)', () => {
    expect(buildFilterPrefixes('reviewing reviews')).toEqual(['rev'])
  })

  it('returns [] for empty query', () => {
    expect(buildFilterPrefixes('')).toEqual([])
  })
})

describe('scoreCandidate', () => {
  const tokens = (query: string) => tokenize(query)

  it('returns null when any token is missing', () => {
    expect(scoreCandidate('Apples', 'pear', tokens('pear'))).toBeNull()
  })

  it('matches all tokens out of order (word skip)', () => {
    // "review pr" → matches "PR Review Skill" via skip
    expect(scoreCandidate('PR Review Skill', 'review pr', tokens('review pr')))
      .not.toBeNull()
  })

  it('tolerates a single-char typo in tokens of length >= 4', () => {
    expect(scoreCandidate('Apples', 'appls', tokens('appls'))).not.toBeNull()
    expect(scoreCandidate('Apples', 'aples', tokens('aples'))).not.toBeNull()
  })

  it('refuses typo tolerance on tokens shorter than 4 chars (avoids noise)', () => {
    expect(scoreCandidate('Apples', 'xyz', tokens('xyz'))).toBeNull()
  })

  describe('word-prefix chain (spaces dropped out of a multi-word title)', () => {
    const chain = (label: string, query: string) =>
      scoreCandidate(label, query, tokens(query))

    it('matches run-together word prefixes', () => {
      expect(chain('Meeting Notes', 'meetnotes')).not.toBeNull()
      expect(chain('Product Requirements Document', 'prodreq')).not.toBeNull()
      expect(chain('Strength Training Program', 'strtrain')).not.toBeNull()
    })

    it('matches initialisms', () => {
      expect(chain('Product Requirements Document', 'prd')).not.toBeNull()
      expect(chain('Strength Training Program', 'stp')).not.toBeNull()
      expect(chain('San Francisco', 'sf')).not.toBeNull()
    })

    it('skips words between chunks', () => {
      expect(chain('Product Requirements Document', 'pd')).not.toBeNull()
      expect(chain('Product Requirements Document', 'proddoc')).not.toBeNull()
    })

    it('keeps chunk order — a chain may skip words but not reorder them', () => {
      expect(chain('Product Requirements Document', 'dp')).toBeNull()
      expect(chain('Meeting Notes', 'notesmeet')).toBeNull()
    })

    it('requires the whole token to be consumed', () => {
      expect(chain('Meeting Notes', 'meetnoteszz')).toBeNull()
      expect(chain('San Francisco', 'sfx')).toBeNull()
    })

    it('needs every chunk to start at a word start, not mid-word', () => {
      // Three words, so the run-together form is two dropped spaces away
      // — out of typo range — and "lpha" is not a prefix of "alpha".
      expect(chain('Alpha Bravo Charlie', 'lphabravocharlie')).toBeNull()
      // Same shape with word-start chunks does match, so the assertion
      // above is pinning the word-start rule and not just the distance.
      expect(chain('Alpha Bravo Charlie', 'alphbravcharl')).not.toBeNull()
    })

    it('does not fire on single-word labels (substring/typo already cover those)', () => {
      expect(chain('Autocomplete', 'atcmp')).toBeNull()
    })

    it('takes at most one chunk from any single word', () => {
      // The DP walks reachable offsets high-to-low precisely so a word
      // cannot extend an offset it just wrote. Walking low-to-high
      // instead accepts all three of these, and nothing else in the
      // suite notices — so this is the only thing pinning that walk.
      expect(chain('Alpha Bravo', 'alal')).toBeNull()
      expect(chain('Alpha Bravo', 'alphalpha')).toBeNull()
      expect(chain('Meeting Notes', 'meetmeet')).toBeNull()
    })

    it('still matches using only the words it can afford on a very long title', () => {
      // Titles past CHAIN_MAX_WORDS degrade to "consider the first N
      // words" rather than refusing outright — punctuation splits push
      // real titles over the cap sooner than the word count suggests.
      // Three run-together chunks, so the typo tier (one edit) cannot
      // rescue it — this only passes via the chain.
      const long = 'Notes from the 2026 Q3 Planning Offsite in San Francisco with the Team'
      expect(chain(long, 'notesfromthe')).not.toBeNull()
    })

    it('ranks below a literal substring and above a typo', () => {
      const substring = scoreCandidate('Strength Training', 'training', tokens('training'))!
      const chained = scoreCandidate('Strength Training', 'strtrain', tokens('strtrain'))!
      const typo = scoreCandidate('Strength', 'strenth', tokens('strenth'))!
      expect(substring).toBeGreaterThan(chained)
      expect(chained).toBeGreaterThan(typo)
    })
  })

  it('ranks exact whole-query match above prefix and substring', () => {
    const exact = scoreCandidate('Dating', 'dating', tokens('dating'))!
    const prefix = scoreCandidate('Dating pool', 'dating', tokens('dating'))!
    const contains = scoreCandidate('Online Dating', 'dating', tokens('dating'))!
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(contains)
  })

  it('ranks word-start higher than mid-word substring', () => {
    const wordStart = scoreCandidate('Java Programming', 'java', tokens('java'))!
    const midWord = scoreCandidate('Megajava', 'java', tokens('java'))!
    expect(wordStart).toBeGreaterThan(midWord)
  })

  it('ranks literal substring above typo match', () => {
    const literal = scoreCandidate('Apples', 'apple', tokens('apple'))!
    const typo = scoreCandidate('Apples', 'aples', tokens('aples'))!
    expect(literal).toBeGreaterThan(typo)
  })
})

describe('rankCandidates', () => {
  it('drops non-matches and orders by score', () => {
    const ranked = rankCandidates({
      candidates: [
        candidate('a', 'Apples'),
        candidate('b', 'Apple Pie'),
        candidate('c', 'Bananas'),
        candidate('d', 'apple'),
      ],
      query: 'apple',
      now: NOW,
    })
    // "apple" exact > "Apples" prefix > "Apple Pie" prefix (length tiebreak)
    expect(labels(ranked)).toEqual(['apple', 'Apples', 'Apple Pie'])
  })

  it('boosts MRU items above other matches at the same tier', () => {
    const ranked = rankCandidates({
      candidates: [
        candidate('older', 'Apple Tarte'),
        candidate('recent', 'Apple Strudel'),
      ],
      query: 'apple',
      recentBlockIds: ['recent'],
      now: NOW,
    })
    expect(labels(ranked)).toEqual(['Apple Strudel', 'Apple Tarte'])
  })

  it('respects MRU position (head beats later)', () => {
    const ranked = rankCandidates({
      candidates: [
        candidate('p1', 'Foo One'),
        candidate('p2', 'Foo Two'),
        candidate('p3', 'Foo Three'),
      ],
      query: 'foo',
      recentBlockIds: ['p3', 'p2', 'p1'],
      now: NOW,
    })
    expect(labels(ranked)).toEqual(['Foo Three', 'Foo Two', 'Foo One'])
  })

  it('boosts recently-edited blocks', () => {
    const ranked = rankCandidates({
      candidates: [
        candidate('stale', 'Apple Tarte', NOW - 30 * 24 * 60 * 60 * 1000),
        candidate('fresh', 'Apple Strudel', NOW - 60 * 1000),
      ],
      query: 'apple',
      now: NOW,
    })
    expect(labels(ranked)).toEqual(['Apple Strudel', 'Apple Tarte'])
  })

  it('keeps exact whole-query match on top even against MRU rivals', () => {
    const ranked = rankCandidates({
      candidates: [
        candidate('exact', 'Inbox'),
        candidate('mru', 'Inbox 2025'),
      ],
      query: 'inbox',
      recentBlockIds: ['mru'],
      now: NOW,
    })
    expect(labels(ranked)).toEqual(['Inbox', 'Inbox 2025'])
  })

  it('returns recency-only ordering when query is empty', () => {
    const ranked = rankCandidates({
      candidates: [
        candidate('p1', 'Page One'),
        candidate('p2', 'Page Two'),
      ],
      query: '',
      recentBlockIds: ['p2'],
      now: NOW,
    })
    expect(labels(ranked)).toEqual(['Page Two', 'Page One'])
  })
})
