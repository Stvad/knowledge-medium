/**
 * Web-archive data model.
 *
 * One block per (source block, URL) archive record — not a `snapshots: [...]`
 * JSON property on the source block. Each record is queryable (the volume
 * stats in `stats.ts` are a query over these blocks, not a counter someone
 * has to keep correct), referenceable, hand-editable, and still reads as a
 * sensible outline line after this plugin is gone:
 *
 *     - Sniffing out a wombat
 *       - Archived https://example.com/wombats → https://web.archive.org/web/…
 *
 * The record's source block is its PARENT — that is the pointer, and it is a
 * real structural edge the outline already renders, so there is no id string
 * and no redundant self-referential ref back up to the parent.
 */

import { ChangeScope, seedProperty, seedType } from '@/data/api'

export const ARCHIVE_SNAPSHOT_TYPE = 'webarchive-snapshot'

/**
 * Lifecycle of one record. Deliberately distinguishes "we sent the request"
 * from "we have seen the archived copy": a browser `fetch` to a save endpoint
 * is frequently opaque (no-cors), so treating a resolved request as proof of
 * archival would be claiming a success we never observed.
 *
 *   pending   — URL noticed, nothing sent yet (the durable queue entry)
 *   submitted — request accepted by the service, archive URL not yet known
 *   archived  — archive URL verified by reading it back from the service
 *   failed    — gave up after `MAX_ATTEMPTS`, or the service refused
 *   skipped   — matched a filter after the record existed (e.g. the user
 *               added the host to their denylist while it was still pending)
 */
export type ArchiveStatus =
  | 'pending'
  | 'submitted'
  | 'archived'
  | 'failed'
  | 'skipped'

export const archiveStatusProp = seedProperty<ArchiveStatus>({
  seedKey: 'system:web-archive/property/status',
  revision: 1,
  name: 'webarchive:status',
  preset: 'strict-enum',
  config: {
    options: [
      {value: 'pending', label: 'pending'},
      {value: 'submitted', label: 'submitted'},
      {value: 'archived', label: 'archived'},
      {value: 'failed', label: 'failed'},
      {value: 'skipped', label: 'skipped'},
    ],
  },
  defaultValue: 'pending',
  changeScope: ChangeScope.Automation,
})

/** The public URL found in the source block's content. */
export const archiveSourceUrlProp = seedProperty({
  seedKey: 'system:web-archive/property/url',
  revision: 1,
  name: 'webarchive:url',
  preset: 'url',
  defaultValue: '',
  changeScope: ChangeScope.Automation,
})

/** The archived copy. Empty until a snapshot has actually been read back. */
export const archiveUrlProp = seedProperty({
  seedKey: 'system:web-archive/property/archive-url',
  revision: 1,
  name: 'webarchive:archiveUrl',
  preset: 'url',
  defaultValue: '',
  changeScope: ChangeScope.Automation,
})

/** Which `ArchiveService` produced this record — the seam is swappable, so a
 *  record has to say who it belongs to or a service switch orphans its rows. */
export const archiveServiceProp = seedProperty({
  seedKey: 'system:web-archive/property/service',
  revision: 1,
  name: 'webarchive:service',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.Automation,
})

/** When the submit request was accepted. THE rate-accounting timestamp:
 *  `stats.ts` counts records by this field, so it means "we published this
 *  URL to a third party at this moment" and nothing else. Unset while
 *  pending. */
export const archiveSubmittedAtProp = seedProperty({
  seedKey: 'system:web-archive/property/submitted-at',
  revision: 1,
  name: 'webarchive:submittedAt',
  preset: 'date',
  changeScope: ChangeScope.Automation,
})

/** Last network attempt of any kind (submit or read-back). Drives backoff. */
export const archiveLastAttemptAtProp = seedProperty({
  seedKey: 'system:web-archive/property/last-attempt-at',
  revision: 1,
  name: 'webarchive:lastAttemptAt',
  preset: 'date',
  changeScope: ChangeScope.Automation,
})

export const archiveAttemptsProp = seedProperty({
  seedKey: 'system:web-archive/property/attempts',
  revision: 1,
  name: 'webarchive:attempts',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.Automation,
})

/** Why the last attempt failed, in the user's own outline rather than only in
 *  a console nobody reads. */
export const archiveErrorProp = seedProperty({
  seedKey: 'system:web-archive/property/error',
  revision: 1,
  name: 'webarchive:error',
  preset: 'optional-string',
  changeScope: ChangeScope.Automation,
})

export const archiveSnapshotType = seedType({
  seedKey: 'system:web-archive/type/snapshot',
  revision: 1,
  id: ARCHIVE_SNAPSHOT_TYPE,
  label: 'Archive snapshot',
  description: 'A public URL submitted to a web archive, and the archived copy.',
  properties: [
    archiveSourceUrlProp,
    archiveUrlProp,
    archiveStatusProp,
    archiveServiceProp,
    archiveSubmittedAtProp,
    archiveLastAttemptAtProp,
    archiveAttemptsProp,
    archiveErrorProp,
  ],
})
