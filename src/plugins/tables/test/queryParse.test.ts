import { describe, expect, it } from 'vitest'
import { formatQuery } from '../query/format'
import { parseQuery, type ParseOptions } from '../query/parse'
import { MARY, PROJECTS, PROPERTIES, localDayStart, resolver } from './queryFixtures'

const SELF = '0190a0c0-0000-7000-8000-00000000000c'
const options: ParseOptions = {selfId: SELF, localDayStart}
const parse = (text: string) => parseQuery(text, resolver, options)
const day = (iso: string) => Date.parse(iso)

describe('parseQuery terms', () => {
  it.each([
    {text: '', query: {}},
    {text: '#book', query: {types: ['t-book']}},
    {text: '#Book', query: {types: ['t-book']}},
    {text: '#book^t-book', query: {types: ['t-book']}},
    {text: '#stale-label^t-book', query: {types: ['t-book']}},
    {text: '#"Reading list"', query: {types: ['t-reading']}},
    {text: '#book|#article', query: {types: ['t-book', 't-article']}},
    {text: '#book | #article', query: {types: ['t-book', 't-article']}},
    {text: '#book #article', query: {types: ['t-book'], match: [{types: ['t-article']}]}},
    {text: '!#book', query: {exclude: [{types: ['t-book']}]}},
    {text: 'status=open', query: {match: [{where: {status: {eq: 'open'}}}]}},
    {text: 'status="two words"', query: {match: [{where: {status: {eq: 'two words'}}}]}},
    {text: 'status^f-status=open', query: {match: [{where: {status: {eq: 'open'}}}]}},
    {text: 'old-name^f-status=open', query: {match: [{where: {status: {eq: 'open'}}}]}},
    {text: 'status!=open', query: {exclude: [{where: {status: {eq: 'open'}}}]}},
    {text: 'label=""', query: {match: [{where: {label: {eq: ''}}}]}},
    {text: 'label="say \\"hi\\" \\\\"', query: {match: [{where: {label: {eq: 'say "hi" \\'}}}]}},
    {text: 'label=a:b.c', query: {match: [{where: {label: {eq: 'a:b.c'}}}]}},
    {text: '"due date"=soon', query: {match: [{where: {'due date': {eq: 'soon'}}}]}},
    {text: 'rating>=3', query: {match: [{where: {rating: {gte: 3}}}]}},
    {text: 'rating<-1.5', query: {match: [{where: {rating: {lt: -1.5}}}]}},
    {text: 'rating=1e3', query: {match: [{where: {rating: {eq: 1000}}}]}},
    {text: 'done=true', query: {match: [{where: {done: {eq: true}}}]}},
    {text: 'done=false', query: {match: [{where: {done: {eq: false}}}]}},
    {text: 'label', query: {match: [{where: {label: {exists: true}}}]}},
    {text: '!label', query: {match: [{where: {label: {exists: false}}}]}},
    {text: 'assignee', query: {match: [{where: {assignee: {exists: true}}}]}},
    {text: 'tags=urgent', query: {match: [{where: {tags: {contains: 'urgent'}}}]}},
    {text: 'tags!=urgent', query: {exclude: [{where: {tags: {contains: 'urgent'}}}]}},
    {text: 'scores=3', query: {match: [{where: {scores: {contains: 3}}}]}},
    {text: 'assignee=[[Mary]]', query: {match: [{referencedBy: {id: MARY, sourceField: 'assignee'}}]}},
    {text: `assignee=((${MARY}))`, query: {match: [{referencedBy: {id: MARY, sourceField: 'assignee'}}]}},
    {text: `assignee=[M](((${MARY.toUpperCase()})))`, query: {match: [{referencedBy: {id: MARY, sourceField: 'assignee'}}]}},
    {text: 'assignee!=[[Mary]]', query: {exclude: [{referencedBy: {id: MARY, sourceField: 'assignee'}}]}},
    {text: 'related=[[Mary]]', query: {match: [{referencedBy: {id: MARY, sourceField: 'related'}}]}},
    {text: 'refs=[[Mary]]', query: {match: [{referencedBy: {id: MARY}}]}},
    {text: 'childof=self', query: {parentId: SELF}},
    {text: 'childof=[[Projects]]', query: {parentId: PROJECTS}},
    {text: '#book under=[[Projects]]', query: {types: ['t-book'], match: [{scope: 'ancestor', id: PROJECTS}]}},
    {text: 'under^f-under=x', query: {match: [{where: {under: {eq: 'x'}}}]}},
    {text: 'status=open | rating>3', query: {anyOf: [{where: {status: {eq: 'open'}}}, {where: {rating: {gt: 3}}}]}},
    {text: '(status=open|#book) done=true', query: {
      match: [{where: {done: {eq: true}}}], anyOf: [{where: {status: {eq: 'open'}}}, {types: ['t-book']}],
    }},
    {text: '#book status=open\n  rating>1\n', query: {
      types: ['t-book'], match: [{where: {status: {eq: 'open'}}}, {where: {rating: {gt: 1}}}],
    }},
  ])('$text', ({text, query}) => {
    const result = parse(text)
    expect(result.errors).toEqual([])
    expect(result.query).toEqual(query)
  })
})

describe('parseQuery dates', () => {
  // localDayStart is UTC+2: the local day 2026-01-05 runs from 2026-01-04T22:00Z to 2026-01-05T22:00Z.
  const start = day('2026-01-04T22:00:00.000Z')
  const next = day('2026-01-05T22:00:00.000Z')
  it.each([
    {text: 'created=2026-01-05', where: {created: {between: [start, next - 1]}}},
    {text: 'created<2026-01-05', where: {created: {lt: start}}},
    {text: 'created<=2026-01-05', where: {created: {lte: next - 1}}},
    {text: 'created>2026-01-05', where: {created: {gt: next - 1}}},
    {text: 'updated>=2026-01-05', where: {updated: {gte: start}}},
    {text: 'created>2026-01-05T10:00:00.000Z', where: {created: {gt: day('2026-01-05T10:00:00.000Z')}}},
  ])('$text bounds the local day', ({text, where}) => {
    const result = parse(text)
    expect(result.errors).toEqual([])
    expect(result.query).toEqual({match: [{where}]})
  })

  it('negates a day as the whole day', () => {
    expect(parse('created!=2026-01-05').query).toEqual({exclude: [{where: {created: {between: [start, next - 1]}}}]})
  })

  it('reads a date property day in UTC, where a picked date is stored', () => {
    expect(parse('due=2026-01-05').query).toEqual({match: [{where: {due: {between: [
      '2026-01-05T00:00:00.000Z', '2026-01-05T23:59:59.999Z',
    ]}}}]})
    expect(parse('due<=2026-01-05').query).toEqual({match: [{where: {due: {lte: '2026-01-05T23:59:59.999Z'}}}]})
  })

  it('crosses a month end', () => {
    expect(parse('due>2026-01-31').query).toEqual({match: [{where: {due: {gt: '2026-01-31T23:59:59.999Z'}}}]})
  })
})

describe('parseQuery errors', () => {
  const errorsOf = (text: string) => parse(text).errors.map(({start, end, message}) => ({span: text.slice(start, end), message}))

  it.each([
    {text: 'nope=1', span: 'nope', message: 'No property or field named nope'},
    {text: 'x^f-missing=1', span: 'x^f-missing', message: 'No property with id f-missing'},
    {text: '#nope', span: '#nope', message: 'No type named nope'},
    {text: '#x^t-missing', span: '#x^t-missing', message: 'No type with id t-missing'},
    {text: 'status=nope', span: 'nope', message: '"nope" is not a value of status: one of open, closed, two words'},
    {text: 'rating=many', span: 'many', message: 'rating takes a number'},
    {text: 'rating=0x10', span: '0x10', message: 'rating takes a number'},
    {text: 'done=yes', span: 'yes', message: 'done takes true or false'},
    {text: 'due=2026-02-30', span: '2026-02-30', message: 'due takes a date like 2026-01-31 or an ISO instant'},
    {text: 'created>yesterday', span: 'yesterday', message: 'created takes a date like 2026-01-31 or an ISO instant'},
    {text: 'created>2026-13-01', span: '2026-13-01', message: 'created takes a date like 2026-01-31 or an ISO instant'},
    {text: 'created', span: 'created', message: 'created is always set; compare it, as in created>2026-01-01'},
    {text: 'label>m', span: 'label>m', message: 'label compares with = or != only'},
    {text: 'tags>a', span: 'tags>a', message: 'tags is a list; test a member with = or !='},
    {text: 'scores=many', span: 'many', message: 'scores takes a number'},
    {text: 'assignee=Mary', span: 'Mary', message: 'assignee= takes [[page]] or ((block id))'},
    {text: 'assignee<[[Mary]]', span: 'assignee<', message: 'assignee is a reference; compare it with = or !='},
    {text: 'assignee=[[Nobody]]', span: '[[Nobody]]', message: 'No page named [[Nobody]]'},
    {text: 'label=[[Mary]]', span: '[[', message: 'label is not a reference property; quote the text to compare it'},
    {text: 'label=', span: 'label=', message: 'Expected a value after ='},
    {text: 'label="open', span: '"', message: 'Unclosed quote'},
    {text: '!label=x', span: '!label=', message: 'Write != instead of a leading !'},
    {text: '"vendor"', span: '"vendor"', message: 'Text search is not supported yet'},
    {text: 'childof=self childof=[[Projects]]', span: 'childof=[[Projects]]', message: 'Only one childof= per query'},
    {text: 'under=[[Projects]]', span: 'under=[[Projects]]', message: 'under= needs another term that narrows the rows, such as a #type or a property value'},
    {text: 'refs=x', span: 'refs=x', message: 'refs= takes [[page]] or ((block id))'},
    {text: 'refs>[[Mary]]', span: 'refs>', message: 'refs takes ='},
    {text: 'status=open | status!=closed', span: 'status!=closed', message: 'A negated or childof term cannot be one side of |'},
    {text: '(label=1 rating=2)', span: 'r', message: 'Join the terms of a group with |'},
    {text: 'status=open | ', span: ' ', message: 'Expected a term'},
    {text: 'label=a)', span: ')', message: 'Unexpected )'},
    {text: 'label=x"y"', span: '"', message: 'Unexpected "\\""'},
  ])('$text', ({text, span, message}) => {
    expect(errorsOf(text)).toContainEqual({span, message})
  })

  it('keeps the terms around an error', () => {
    const result = parse('#book nope=1 status=open')
    expect(result.errors).toHaveLength(1)
    expect(result.query).toEqual({types: ['t-book'], match: [{where: {status: {eq: 'open'}}}]})
  })

  it.each(['label=x', 'label^f-label=x', 'other^f-label=x'])('names a property named like a field as ambiguous: %s', text => {
    const shadowed = {...resolver, isField: (name: string) => name === 'label'}
    expect(parseQuery(text, shadowed).errors.map(error => error.message))
      .toEqual(['label is both a property and a field; rename the property to query it'])
  })

  it('needs a table for childof=self', () => {
    expect(parseQuery('childof=self', resolver).errors[0]?.message).toBe('childof=self needs a table to belong to')
  })

  it('keeps a group\'s ) and the terms after a failed alternative', () => {
    const result = parse('(status=open |) rating>1')
    expect(result.errors.map(error => error.message)).toEqual(['Expected a term'])
    expect(result.query).toEqual({match: [{where: {rating: {gt: 1}}}]})
  })

  it('resumes after an unclosed quote at the next term', () => {
    const result = parse('status="open rating>1')
    expect(result.errors.map(error => error.message)).toEqual(['Unclosed quote'])
    expect(result.query).toEqual({match: [{where: {rating: {gt: 1}}}]})
  })

  it.each(['due=2026-13-01T00:00:00.000Z', 'created>2026-02-30T00:00:00.000Z'])('refuses an instant that names no moment: %s', text => {
    const result = parse(`${text} rating>1`)
    expect(result.errors).toHaveLength(1)
    expect(result.query).toEqual({match: [{where: {rating: {gt: 1}}}]})
  })

  it('bounds under= only by a term that stays', () => {
    const result = parse('(under=[[Projects]] | rating>1) (label=a | status=open)')
    expect(result.errors.map(error => error.message)).toEqual([expect.stringContaining('under= needs'), 'Only one | group per query'])
    expect(result.query).toEqual({})
  })

  it('refuses an instant past year 9999', () => {
    expect(parse('due<+010000-01-01T00:00:00.000Z').errors).toHaveLength(1)
  })

  it('reads an alias with brackets as the reference grammar does', () => {
    const nested = {...resolver, blockIdByAlias: (alias: string) => alias === 'Book of [x]' ? MARY : undefined}
    expect(parseQuery('assignee=[[Book of [x]]]', nested).query)
      .toEqual({match: [{referencedBy: {id: MARY, sourceField: 'assignee'}}]})
  })

  it('reports every unbounded under= of a long query', () => {
    expect(parse('under=[[Projects]] '.repeat(10_000)).errors).toHaveLength(10_000)
  })

  it('allows one | group', () => {
    const result = parse('(status=open | rating>1) (done=true | label)')
    expect(result.errors.map(error => error.message)).toEqual(['Only one | group per query'])
    expect(result.query.anyOf).toHaveLength(2)
  })
})

describe('formatQuery', () => {
  it('quotes ids the parser would otherwise end early', () => {
    const odd = {...PROPERTIES[2]!, fieldId: 'a b^"c|d)'}
    const oddResolver = {...resolver, propertyById: (id: string) => id === odd.fieldId ? odd : undefined}
    const saved = formatQuery(parseQuery(`label^"a b^\\"c|d)"=x`, oddResolver).terms)
    expect(parseQuery(saved, oddResolver).errors).toEqual([])
    expect(parseQuery(saved, oddResolver).query).toEqual({match: [{where: {label: {eq: 'x'}}}]})
  })
})
