import type { AliasSeatNamespaces } from '@/data/aliasSeatNamespace'

const PUBLIC_ALIAS_SEAT_NS = 'a3c8a8c0-7c3a-4d2c-bc4f-1f6c2c6a7d11'

/** A plaintext workspace's alias-seat namespaces, for tests. Spelled out
 *  rather than imported: production code asks the resolvers in
 *  `@/data/aliasSeatNamespace`, which therefore does not export it, and
 *  `aliasSeatNamespace.test.ts` pins that the resolver agrees. */
export const PLAINTEXT_ALIAS_SEATS: AliasSeatNamespaces = Object.freeze({
  mint: PUBLIC_ALIAS_SEAT_NS,
  recognized: Object.freeze([PUBLIC_ALIAS_SEAT_NS]),
})
