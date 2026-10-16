/**
 * The agent-ergonomics eval fixture: a deterministic Roam export of a
 * fictional team's notebook, imported through the real Roam importer so the
 * graph carries the same importer metadata a real imported graph does.
 *
 * Every shape the dogfooding pass found expensive is here on purpose: pages
 * with hundreds of bare `[[Standup]]` / `[[Meeting]]` backlinks whose content
 * lives in their children, a page with thousands of direct children, a single
 * pasted-source block of ~100 KB that full-text search matches, vendor pages
 * whose facts live in promoted `key:: value` attributes, and nested todos.
 *
 * `buildFixture()` also returns the ground truth the tasks are checked
 * against, derived from the same generated data, so the two cannot drift.
 * All names and content are invented.
 */
import { createHash } from 'node:crypto'
import type { RoamBlock, RoamExport, RoamPage } from '@/plugins/roam-import/types'

export const FIXTURE_FIRST_DAY = '2026-01-01'
export const FIXTURE_LAST_DAY = '2026-08-31'

export const PEOPLE = [
  'Ines Varga',
  'Tomas Reyes',
  'Priya Nand',
  'Oskar Lind',
  'Mei Tanaka',
  'Dara Quinn',
] as const

interface Vendor {
  name: string
  status: 'renewal due' | 'active' | 'churned'
  owner: (typeof PEOPLE)[number]
  service: string
}

export const VENDORS: readonly Vendor[] = [
  {name: 'Kestrel', status: 'renewal due', owner: 'Tomas Reyes', service: 'payments'},
  {name: 'Bluefin Analytics', status: 'active', owner: 'Mei Tanaka', service: 'product analytics'},
  {name: 'Larkspur Hosting', status: 'renewal due', owner: 'Oskar Lind', service: 'hosting'},
  {name: 'Copperline', status: 'churned', owner: 'Ines Varga', service: 'support desk'},
  {name: 'Nimbus Mail', status: 'active', owner: 'Dara Quinn', service: 'transactional email'},
  {name: 'Halyard Security', status: 'renewal due', owner: 'Priya Nand', service: 'pen testing'},
]

export const PROJECT_PAGE = 'Project Orchard'
export const DESIGN_PAGE = 'Design: Offline Sync v2'
export const READING_LOG_PAGE = 'Reading Log'
export const READING_LOG_ENTRIES = 2_000
export const PASTED_SOURCE_PAGE = 'kestrel-webhooks.ts (pasted)'
export const ROLLOUT_BLOCK_TEXT =
  'Target: Q3 2026 behind the `sync-v2` flag, starting with internal workspaces.'
export const PRICING_FAQ_TODO = 'Draft pricing FAQ'
export const NEEDLE_BOOK = {title: 'The Quiet Lattice', rating: 4, recommendedBy: 'Mei Tanaka'} as const

/** Roam uids of the blocks write tasks edit. The importer derives a block's
 *  id from (workspace, uid), so a check finds its target by identity even
 *  after an agent has rewritten the content. */
export const TARGET_UIDS = {
  rollout: 'eval-rollout',
  pricingFaqTodo: 'eval-pricing-faq',
  vendorsSection: 'eval-vendors-section',
} as const

export interface FixtureTruth {
  /** ISO dates in June 2026 whose daily note mentions Kestrel anywhere in its outline. */
  kestrelJuneDates: string[]
  /** ISO dates whose standup reported a blocker involving the staging database. */
  stagingBlockerDates: string[]
  /** Open (not done) todos anywhere in the Project Orchard page's outline. */
  openOrchardTodos: string[]
  /** Vendor pages whose Status attribute is "renewal due". */
  renewalDueVendors: string[]
  needleBook: typeof NEEDLE_BOOK
  /** One date per meeting with Ines Varga in July 2026 (a date repeats for a second meeting that day). */
  julyMeetingsWithInes: string[]
  /** Reading-log titles rated 5/5 and recommended by Tomas Reyes. */
  tomasFiveStarBooks: string[]
  design: {author: string, openQuestions: number, decisionKeyword: string}
}

export interface Fixture {
  pages: RoamExport
  truth: FixtureTruth
  /** Hash of the generated pages; the seeded graph carries it on the marker page. */
  hash: string
}

/** Holds the fixture hash in the seeded graph, so a run can tell whether the
 *  graph it is about to score was seeded from THIS generator. */
export const FIXTURE_MARKER_PAGE = 'Agent Eval Fixture'
export const FIXTURE_HASH_PREFIX = 'Fixture hash: '

/** mulberry32: small, fast, and stable across engines — the fixture has to
 *  be byte-identical on every machine that seeds it. */
const createRng = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (minInclusive: number, maxInclusive: number) =>
    minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1))
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  return {next, int, pick}
}

type Rng = ReturnType<typeof createRng>

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const ordinalSuffix = (day: number): string => {
  if (day >= 11 && day <= 13) return 'th'
  switch (day % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

/** Roam's daily-page title, e.g. "June 12th, 2026". */
export const roamDailyTitle = (iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number)
  return `${MONTHS[month - 1]} ${day}${ordinalSuffix(day)}, ${year}`
}

const roamDailyUid = (iso: string): string => {
  const [year, month, day] = iso.split('-')
  return `${month}-${day}-${year}`
}

const isoDays = (first: string, last: string): string[] => {
  const out: string[] = []
  const end = Date.parse(`${last}T00:00:00Z`)
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

const isWeekday = (iso: string): boolean => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return day !== 0 && day !== 6
}

/** Builds blocks with sequential uids and timestamps, plus the per-block
 *  importer metadata every Roam export carries. */
const createBlockFactory = () => {
  let counter = 0
  let clock = Date.parse(`${FIXTURE_FIRST_DAY}T09:00:00Z`)
  const setClock = (iso: string) => {
    clock = Math.max(clock, Date.parse(`${iso}T09:00:00Z`))
  }
  const block = (
    string: string,
    children: RoamBlock[] = [],
    options: {uid?: string, user?: string, extra?: Record<string, unknown>, heading?: number} = {},
  ): RoamBlock => {
    counter += 1
    clock += 61_000
    const user = {':user/uid': options.user ?? 'u-ines'}
    return {
      uid: options.uid ?? `fx${counter.toString(36).padStart(7, '0')}`,
      string,
      'create-time': clock,
      'edit-time': clock + 30_000,
      ':create/user': user,
      ':edit/user': user,
      ...(options.heading ? {heading: options.heading} : {}),
      ...(options.extra ?? {}),
      ...(children.length > 0 ? {children} : {}),
    }
  }
  return {block, setClock}
}

type BlockFactory = ReturnType<typeof createBlockFactory>

const page = (title: string, uid: string, children: RoamBlock[], createTime: number): RoamPage => ({
  title,
  uid,
  'create-time': createTime,
  'edit-time': createTime,
  ':create/user': {':user/uid': 'u-ines'},
  children,
})

const userFor = (rng: Rng) => `u-${rng.pick(PEOPLE).split(' ')[0].toLowerCase()}`

const WORK_ITEMS = [
  'reviewed the sync rollout checklist',
  'paired on the outline renderer',
  'triaged the support queue',
  'wrote tests for the importer edge cases',
  'cleaned up the release notes draft',
  'profiled the search index rebuild',
  'updated the onboarding emails',
  'fixed the flaky date-picker test',
  'drafted the quarterly planning doc',
  'reviewed the accessibility audit findings',
  'migrated the feature flags service',
  'answered questions in the design partners channel',
]

const OTHER_BLOCKERS = [
  'waiting on design review',
  'flaky e2e suite on CI',
  'VPN outage in the morning',
  'blocked on legal sign-off for the terms update',
]

const STAGING_BLOCKERS = [
  'migrations keep failing on the staging database',
  'staging database ran out of disk overnight',
  'waiting on the staging database restore',
  'staging database credentials were rotated and CI cannot connect',
  'staging database replica lag makes the e2e suite time out',
]

const MEETING_TOPICS = [
  'roadmap review',
  'hiring loop debrief',
  'support escalations',
  'sync v2 rollout',
  'design partner feedback',
  'incident review',
  'launch comms',
  'budget check-in',
]

const KESTREL_TOPICS = [
  'contract renewal terms',
  'pricing tiers for the new plan',
  'SLA credits after the March outage',
  'webhook retry behaviour',
]

const JOURNAL_LINES = [
  'Long day; mostly heads-down on the renderer.',
  'Noticed the search index rebuild takes longer on large pages.',
  'Read two chapters before bed.',
  'Should write up the sync design rationale somewhere durable.',
  'Coffee with the design partners lead — good energy about the beta.',
  'Need to renew the conference talk proposal.',
  'Spent an hour tidying the team handbook.',
]

const KESTREL_PLAIN_LINES = [
  'emailed kestrel support about webhook retries timing out',
  'kestrel dashboard was down for twenty minutes',
  'drafted questions for the kestrel renewal call',
]

/** Days chosen so each truth set has a handful of members spread across
 *  the window — fixed, not random, so the truth is legible in this file. */
const STAGING_BLOCKER_DAYS = new Set(['2026-02-10', '2026-03-24', '2026-05-07', '2026-07-14', '2026-08-19'])
const STAGING_DISTRACTOR_DAY = '2026-06-03'
const KESTREL_MEETING_DAYS = new Set([
  '2026-01-20', '2026-02-17', '2026-03-12', '2026-04-08', '2026-05-19',
  '2026-06-04', '2026-06-18', '2026-07-09', '2026-08-13',
])
const KESTREL_PLAIN_DAYS = new Set(['2026-03-03', '2026-06-11', '2026-06-25', '2026-07-30'])
const KESTREL_TAG_DAYS = new Set(['2026-05-28', '2026-06-29'])
const PRICING_FAQ_REMINDER_DAY = '2026-06-16'

const dailyNote = (iso: string, rng: Rng, f: BlockFactory): RoamPage => {
  f.setClock(iso)
  const children: RoamBlock[] = []

  if (isWeekday(iso)) {
    const blocker = STAGING_BLOCKER_DAYS.has(iso)
      ? STAGING_BLOCKERS[[...STAGING_BLOCKER_DAYS].indexOf(iso)]
      : rng.next() < 0.15 ? rng.pick(OTHER_BLOCKERS) : 'none'
    children.push(f.block('[[Standup]]', [
      f.block(`Yesterday: ${rng.pick(WORK_ITEMS)}`),
      f.block(`Today: ${rng.pick(WORK_ITEMS)}`),
      f.block(`Blockers: ${blocker}`),
    ]))
  }

  const meetingCount = rng.int(1, 4)
  for (let i = 0; i < meetingCount; i++) {
    const withKestrel = i === 0 && KESTREL_MEETING_DAYS.has(iso)
    const attendee = withKestrel ? '[[Kestrel]] account team' : `[[${rng.pick(PEOPLE)}]]`
    const topic = withKestrel ? rng.pick(KESTREL_TOPICS) : rng.pick(MEETING_TOPICS)
    const notes = [
      f.block(`with ${attendee}`),
      f.block(`topic: ${topic}`),
      f.block(`notes: ${rng.pick(JOURNAL_LINES)}`, [], {user: userFor(rng)}),
    ]
    if (iso === STAGING_DISTRACTOR_DAY && i === 0) {
      notes.push(f.block('we should snapshot the staging database weekly before migrations'))
    }
    children.push(f.block('[[Meeting]]', notes))
  }

  if (KESTREL_PLAIN_DAYS.has(iso)) {
    children.push(f.block(KESTREL_PLAIN_LINES[[...KESTREL_PLAIN_DAYS].indexOf(iso) % KESTREL_PLAIN_LINES.length]))
  }
  if (KESTREL_TAG_DAYS.has(iso)) {
    children.push(f.block('Invoice reconciliation is off by a few cents again #Kestrel'))
  }
  if (iso === PRICING_FAQ_REMINDER_DAY) {
    children.push(f.block(`{{[[TODO]]}} nudge Ines about the pricing FAQ for [[${PROJECT_PAGE}]]`))
  }

  const journalCount = rng.int(0, 3)
  for (let i = 0; i < journalCount; i++) {
    const line = rng.pick(JOURNAL_LINES)
    if (rng.next() < 0.1) {
      children.push(f.block(`{{[[TODO]]}} follow up: ${line.toLowerCase()} [[${PROJECT_PAGE}]]`))
    } else if (rng.next() < 0.15) {
      children.push(f.block(`${line} #ideas`))
    } else {
      children.push(f.block(line))
    }
  }

  return page(roamDailyTitle(iso), roamDailyUid(iso), children, Date.parse(`${iso}T08:00:00Z`))
}

const vendorPage = (vendor: Vendor, f: BlockFactory): RoamPage => page(vendor.name, `vendor-${vendor.name.toLowerCase().replace(/\W+/g, '-')}`, [
  f.block('isa:: [[Vendor]]'),
  f.block(`Status:: ${vendor.status}`),
  f.block(`Owner:: [[${vendor.owner}]]`),
  f.block(`Service:: ${vendor.service}`),
  f.block(`Notes on ${vendor.name}: contract is annual; invoices arrive on the first business day of the month.`),
  f.block('Escalation path: account manager first, then the support portal.'),
], Date.parse('2026-01-02T10:00:00Z'))

/** A non-vendor page that shares the vendor pages' Status value, so a query
 *  that forgets to filter by type over-reports. */
const officeLeasePage = (f: BlockFactory): RoamPage => page('Office Lease', 'office-lease', [
  f.block('isa:: [[Contract]]'),
  f.block('Status:: renewal due'),
  f.block('Owner:: [[Dara Quinn]]'),
  f.block('Landlord wants a decision two months before expiry.'),
], Date.parse('2026-01-02T11:00:00Z'))

interface ProjectTodo {
  text: string
  done: boolean
  uid?: string
  children?: Array<ProjectTodo | string>
}

const PROJECT_SECTIONS: Array<{heading: string, items: Array<ProjectTodo | string>}> = [
  {heading: 'Milestones', items: [
    {text: 'Ship private beta to design partners', done: true},
    {text: 'Finalize public launch date', done: false, children: [
      {text: 'Confirm press embargo with comms', done: false},
      {text: 'Book launch venue', done: true},
    ]},
    {text: PRICING_FAQ_TODO, done: false, uid: TARGET_UIDS.pricingFaqTodo},
  ]},
  {heading: 'Vendors', items: VENDORS
    .filter(vendor => vendor.status !== 'churned')
    .map(vendor => `[[${vendor.name}]] — ${vendor.service}`)},
  {heading: 'Launch checklist', items: [
    {text: 'Load test the sync service at 2x peak', done: false},
    {text: 'Write incident runbook', done: true},
    {text: 'Translate onboarding emails', done: false, children: [
      'notes: Spanish and German first',
      {text: 'Review German copy with [[Oskar Lind]]', done: false},
    ]},
    'TODO list conventions are described in [[Team Handbook]]',
    {text: 'Set up status page', done: true},
  ]},
  {heading: 'Ideas Backlog', items: [
    'Idea: referral credits for design partners',
    'Idea: offline-first onboarding checklist',
  ]},
]

const stripLinks = (text: string) => text.replace(/\[\[([^\]]+)\]\]/g, '$1')

const projectPage = (f: BlockFactory, openTodos: string[]): RoamPage => {
  const build = (item: ProjectTodo | string): RoamBlock => {
    if (typeof item === 'string') return f.block(item)
    if (!item.done) openTodos.push(stripLinks(item.text))
    const marker = item.done ? '{{[[DONE]]}}' : '{{[[TODO]]}}'
    return f.block(`${marker} ${item.text}`, (item.children ?? []).map(build), {uid: item.uid})
  }
  return page(PROJECT_PAGE, 'project-orchard', [
    f.block('isa:: [[Project]]'),
    f.block('Owner:: [[Ines Varga]]'),
    ...PROJECT_SECTIONS.map(section => f.block(section.heading, section.items.map(build), {
      heading: 2,
      uid: section.heading === 'Vendors' ? TARGET_UIDS.vendorsSection : undefined,
    })),
  ], Date.parse('2026-01-03T10:00:00Z'))
}

const DESIGN_OPEN_QUESTIONS = [
  'How long do we retain tombstones?',
  'Do we need per-workspace clock skew alarms?',
  'What is the upgrade path for clients older than 1.40?',
  'Should attachments sync on the same channel?',
  'Who signs off on the data-loss test plan?',
]

const designPage = (f: BlockFactory): RoamPage => page(DESIGN_PAGE, 'design-offline-sync-v2', [
  f.block('Author:: [[Priya Nand]]'),
  f.block('Status:: accepted'),
  f.block('Context', [
    f.block('Devices stay offline for days at a time; v1 merges lose edits when two devices change the same block.'),
    f.block('Support sees roughly one lost-edit report a week, almost all from users with a phone and a laptop.'),
    f.block('The current protocol ships whole blocks, so a one-character edit conflicts with a property change.'),
  ], {heading: 2}),
  f.block('Decision', [
    f.block('Adopt per-field last-writer-wins with hybrid logical clocks instead of a CRDT.'),
    f.block('Rationale: field-level merge removes most real conflicts, and the clock keeps ordering stable without a server round trip.'),
    f.block('Rejected: a full CRDT for content — the editor would need a rewrite and storage grows without bound.'),
  ], {heading: 2}),
  f.block('Rollout', [
    f.block(ROLLOUT_BLOCK_TEXT, [], {uid: TARGET_UIDS.rollout}),
    f.block('Migration runs per workspace; rollback is a flag flip.'),
    f.block('Success metric: lost-edit reports drop below one a month.'),
  ], {heading: 2}),
  f.block('Open questions', DESIGN_OPEN_QUESTIONS.map(question => f.block(question)), {heading: 2}),
  f.block('Risks', [
    f.block('Clock skew on devices that never sync could reorder edits.'),
    f.block('Older clients will keep writing whole blocks until they upgrade.'),
  ], {heading: 2}),
], Date.parse('2026-02-02T10:00:00Z'))

const TITLE_FIRST = ['Quiet', 'Hollow', 'Bright', 'Patient', 'Silver', 'Northern', 'Distant', 'Restless',
  'Gentle', 'Broken', 'Hidden', 'Crimson', 'Endless', 'Winter', 'Paper', 'Iron', 'Glass', 'Second',
  'Last', 'Open', 'Slow', 'Wild', 'Narrow', 'Golden', 'Shallow']
const TITLE_SECOND = ['Lattice', 'Harbor', 'Orchard', 'Signal', 'Garden', 'Engine', 'River', 'Archive',
  'Compass', 'Lantern', 'Meridian', 'Atlas', 'Voyage', 'Threshold', 'Ledger', 'Canopy', 'Circuit',
  'Mirror', 'Valley', 'Current', 'Season', 'Margin', 'Horizon', 'Kingdom', 'Pattern', 'Station',
  'Fable', 'Grammar', 'Weather', 'Machine']
const TITLE_SUFFIX = ['', ' of Small Things', ': A Field Guide', ' and Other Stories', ' Revisited']

const readingLogPage = (rng: Rng, f: BlockFactory): RoamPage => {
  const titles: string[] = []
  const seen = new Set<string>([NEEDLE_BOOK.title])
  const combos = TITLE_FIRST.length * TITLE_SECOND.length * TITLE_SUFFIX.length
  for (let i = 0; titles.length < READING_LOG_ENTRIES - 1 && i < combos * 4; i++) {
    const title = `The ${rng.pick(TITLE_FIRST)} ${rng.pick(TITLE_SECOND)}${rng.pick(TITLE_SUFFIX)}`
    if (seen.has(title)) continue
    seen.add(title)
    titles.push(title)
  }
  if (titles.length !== READING_LOG_ENTRIES - 1) {
    throw new Error(`reading log generated ${titles.length} unique titles, wanted ${READING_LOG_ENTRIES - 1}`)
  }
  titles.splice(1_337, 0, NEEDLE_BOOK.title)

  const entries = titles.map((title, index) => {
    const isNeedle = title === NEEDLE_BOOK.title
    const rating = isNeedle ? NEEDLE_BOOK.rating : rng.int(1, 5)
    const recommender = isNeedle
      ? `[[${NEEDLE_BOOK.recommendedBy}]]`
      : rng.next() < 0.2 ? `[[${rng.pick(PEOPLE)}]]` : 'a podcast'
    return f.block(`${title} — rating ${rating}/5 — recommended by ${recommender}`, [], {
      extra: {
        ':readwise/book-id': 40_000_000 + index * 7,
        ':readwise/source': rng.pick(['kindle', 'instapaper', 'pocket', 'manual']),
        ':readwise/highlight-count': rng.int(0, 60),
        ':readwise/last-synced': `2026-0${rng.int(1, 8)}-1${rng.int(0, 9)}T0${rng.int(0, 9)}:00:00Z`,
      },
    })
  })
  return page(READING_LOG_PAGE, 'reading-log', entries, Date.parse('2026-01-04T10:00:00Z'))
}

/** ~100 KB of plausible TypeScript in ONE block — the shape of a pasted
 *  source file, which full-text search matches on its identifiers. */
const pastedSource = (rng: Rng): string => {
  const lines = ['```typescript', '// Kestrel webhook handlers — pasted from the payments service for reference.']
  const entities = ['invoice', 'charge', 'refund', 'subscription', 'payout', 'dispute', 'pricing', 'customer']
  for (let i = 0; i < 160; i++) {
    const entity = rng.pick(entities)
    const name = `${entity}${i}`
    lines.push(
      '',
      `/** Handles the Kestrel \`${entity}.updated\` webhook (variant ${i}). Retries hit the staging database first. */`,
      `export async function handle${name[0].toUpperCase()}${name.slice(1)}(event: KestrelEvent<'${entity}'>, ctx: HandlerContext) {`,
      `  const record = await ctx.db.${entity}s.findById(event.data.id)`,
      '  if (!record) {',
      `    ctx.log.warn('kestrel ${entity} not found', {id: event.data.id, attempt: event.attempt})`,
      '    return {status: 404}',
      '  }',
      `  const pricing = await ctx.pricing.resolve(record.planId, {currency: event.data.currency ?? 'usd'})`,
      `  const next = {...record, amount: event.data.amount, tier: pricing.tier, syncedAt: Date.now()}`,
      `  await ctx.db.${entity}s.update(record.id, next)`,
      `  await ctx.audit.record('kestrel.${entity}.updated', {id: record.id, by: 'webhook'})`,
      '  return {status: 200}',
      '}',
    )
  }
  lines.push('```')
  return lines.join('\n')
}

const pastedSourcePage = (rng: Rng, f: BlockFactory): RoamPage => page(PASTED_SOURCE_PAGE, 'kestrel-webhooks-pasted', [
  f.block('Pasted for reference while debugging the [[Kestrel]] webhook retries.'),
  f.block(pastedSource(rng)),
], Date.parse('2026-03-05T10:00:00Z'))

const HANDBOOK_LINES = [
  'We write decisions down; a decision that only lives in chat did not happen.',
  'Standups are async on Fridays; post Yesterday / Today / Blockers under the day\'s [[Standup]] block.',
  'Every [[Meeting]] block gets a "with", a "topic" and a "notes" child.',
  'TODO list conventions: one action per todo, start with a verb, link the project.',
  'Vendor pages carry isa, Status and Owner attributes so they show up in the vendor table.',
  'Incidents get a written review within five business days.',
  'On-call rotates weekly; hand-offs happen on Monday mornings.',
  'Design docs follow the Context / Decision / Rollout / Open questions / Risks outline.',
]

const supportingPages = (f: BlockFactory): RoamPage[] => [
  page('Team Handbook', 'team-handbook', HANDBOOK_LINES.map(line => f.block(line)), Date.parse('2026-01-02T09:00:00Z')),
  page('Standup', 'standup', [
    f.block('Daily standup notes live on the daily notes: each [[Standup]] block has Yesterday / Today / Blockers children.'),
  ], Date.parse('2026-01-02T09:30:00Z')),
  page('Meeting', 'meeting', [
    f.block('Meeting notes are blocks tagged [[Meeting]] on the daily note of the day they happened.'),
  ], Date.parse('2026-01-02T09:40:00Z')),
  ...PEOPLE.map((person, index) => page(person, `person-${index}`, [
    f.block(`Role:: ${['engineering lead', 'payments engineer', 'staff engineer', 'infrastructure', 'product design', 'operations'][index]}`),
    f.block(`Based in ${['Lisbon', 'Mexico City', 'Pune', 'Malmö', 'Osaka', 'Dublin'][index]}.`),
  ], Date.parse('2026-01-02T10:00:00Z'))),
]

export const buildFixture = (): Fixture => {
  const rng = createRng(0x6b6d_6576)
  const f = createBlockFactory()
  const openOrchardTodos: string[] = []

  const staticPages = [
    ...supportingPages(f),
    ...VENDORS.map(vendor => vendorPage(vendor, f)),
    officeLeasePage(f),
    projectPage(f, openOrchardTodos),
    designPage(f),
    readingLogPage(rng, f),
    pastedSourcePage(rng, f),
  ]
  const days = isoDays(FIXTURE_FIRST_DAY, FIXTURE_LAST_DAY)
  const dailyPages = days.map(iso => dailyNote(iso, rng, f))

  const mentionsKestrel = (blocks: readonly RoamBlock[] | undefined): boolean =>
    (blocks ?? []).some(child => /kestrel/i.test(child.string ?? '') || mentionsKestrel(child.children))
  const kestrelJuneDates = days.filter((iso, index) =>
    iso.startsWith('2026-06-') && mentionsKestrel(dailyPages[index].children))

  const julyMeetingsWithInes = days.flatMap((iso, index) => iso.startsWith('2026-07-')
    ? (dailyPages[index].children ?? [])
      .filter(child => child.string === '[[Meeting]]'
        && (child.children ?? []).some(note => note.string === 'with [[Ines Varga]]'))
      .map(() => iso)
    : [])
  const readingLog = staticPages.find(p => p.title === READING_LOG_PAGE)!
  const tomasFiveStarBooks = (readingLog.children ?? [])
    .map(entry => /^(.*) — rating 5\/5 — recommended by \[\[Tomas Reyes\]\]$/.exec(entry.string ?? '')?.[1])
    .filter((title): title is string => title !== undefined)

  const pages = [...staticPages, ...dailyPages]
  const hash = createHash('sha256').update(JSON.stringify(pages)).digest('hex').slice(0, 12)
  const marker = page(FIXTURE_MARKER_PAGE, 'agent-eval-fixture', [
    f.block(`${FIXTURE_HASH_PREFIX}${hash}`),
    f.block('Seeded by `pnpm agent-eval seed` (scripts/agent-eval). Do not edit this workspace by hand.'),
  ], Date.parse('2026-01-01T00:00:00Z'))

  return {
    hash,
    pages: [...pages, marker],
    truth: {
      kestrelJuneDates,
      stagingBlockerDates: [...STAGING_BLOCKER_DAYS].filter(isWeekday).sort(),
      openOrchardTodos,
      renewalDueVendors: VENDORS.filter(vendor => vendor.status === 'renewal due').map(vendor => vendor.name),
      needleBook: NEEDLE_BOOK,
      julyMeetingsWithInes,
      tomasFiveStarBooks,
      design: {author: 'Priya Nand', openQuestions: DESIGN_OPEN_QUESTIONS.length, decisionKeyword: 'last-writer-wins'},
    },
  }
}

/** Count every block (pages included) in an export — the fingerprint test
 *  pins it so a generator change is a visible decision. */
export const countBlocks = (pages: RoamExport): number => {
  const walk = (blocks: readonly RoamBlock[] | undefined): number =>
    (blocks ?? []).reduce((sum, child) => sum + 1 + walk(child.children), 0)
  return pages.reduce((sum, p) => sum + 1 + walk(p.children), 0)
}
