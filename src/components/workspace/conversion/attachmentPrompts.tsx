/**
 * What the conversion says about attachments: media nothing can bring back,
 * objects too big to upload sealed, and what the cleaner left behind. Nothing
 * the conversion leaves on the server goes unlisted.
 */

import { useState } from 'react'
import { Explanation } from '@/components/workspace/keyUi'
import { limitToRaise, type CleanerReport, type LeftReason, type UnrecoverableMedia } from '@/sync/conversion/attachmentCleaner'
import type { OversizedObject } from '@/sync/conversion/bundle/attachmentParts'
import type { FinishPrompt } from '@/sync/conversion/cleaningStage'
import { Actions, ScrollList, ConfirmCheck, formatBytes } from './flowUi'

const Mono = ({children}: {children: string}) => <span className="font-mono text-xs">{children}</span>

export function MediaList({media}: {media: readonly UnrecoverableMedia[]}) {
  return (
    <ScrollList
      items={media}
      render={item => (
        <>
          <Mono>{item.contentHash}</Mono>
          {item.blockIds.length > 0 && <>, in block {item.blockIds.map((id, i) => <span key={id}>{i > 0 && ', '}<Mono>{id}</Mono></span>)}</>}
        </>
      )}
    />
  )
}

/** The media with no hash-verified copy anywhere, and the check accepting it. */
export function NoVerifiedSourceNotice({media, accepted, onAccept}: {
  media: readonly UnrecoverableMedia[]
  accepted: boolean
  onAccept: (accepted: boolean) => void
}) {
  return (
    <>
      <Explanation>
        {media.length} attachment(s) have no copy, on this device or on the server, whose bytes match
        what their blocks record. The recovery bundle can't hold them, and nothing after the conversion
        can bring them back:
      </Explanation>
      <MediaList media={media}/>
      <ConfirmCheck id="conversion-no-source" checked={accepted} onChange={onAccept}>
        These attachments' bytes are lost.
      </ConfirmCheck>
    </>
  )
}

/** Asked as the bundle is taken, for whatever has no verified copy then. */
export function NoVerifiedSourcePrompt({media, answer, cancel}: {
  media: readonly UnrecoverableMedia[]
  answer: () => void
  cancel: () => void
}) {
  const [accepted, setAccepted] = useState(false)
  return (
    <>
      <NoVerifiedSourceNotice media={media} accepted={accepted} onAccept={setAccepted}/>
      <Actions primary={{label: 'Continue', onClick: answer, disabled: !accepted}} secondary={{label: 'Cancel', onClick: cancel}}/>
    </>
  )
}

/** The remedy for an upload over the hosted project's limits. */
const raiseLimits = (bytes: number): string =>
  `Raise the hosted project's upload limits to at least ${formatBytes(bytes)} (${bytes} bytes): the project-wide ` +
  "Storage limit, and the attachments bucket's own limit if it's lower."

/** The remedy sentence (with its leading space) for refusals that were over a
 *  limit; empty when none were. */
const raiseRemedy = (refused: CleanerReport['refused']): string => {
  const bytes = limitToRaise(refused)
  return bytes === null ? '' : ` ${raiseLimits(bytes)}`
}

export function OversizedNotice({oversized, raised, onRaised}: {
  oversized: readonly OversizedObject[]
  raised: boolean
  onRaised: (raised: boolean) => void
}) {
  const largest = Math.max(...oversized.map(item => item.sealedBytes))
  return (
    <>
      <Explanation>
        {oversized.length} attachment(s) are too big to upload once encrypted:
      </Explanation>
      <ScrollList items={oversized} render={item => <><Mono>{item.what}</Mono>: {formatBytes(item.sealedBytes)} encrypted</>}/>
      <Explanation>
        {raiseLimits(largest)} If the limits are still too low, nothing is lost: each original stays
        on the server until its encrypted copy uploads, and the conversion waits for it.
      </Explanation>
      <ConfirmCheck id="conversion-limits" checked={raised} onChange={onRaised}>
        The upload limits are raised to at least {formatBytes(largest)}.
      </ConfirmCheck>
    </>
  )
}

const LEFT_REASON: Record<LeftReason, string> = {
  'not-archived': 'the recovery bundle has no copy of it',
  'bundle-unreadable': "the recovery bundle's folder couldn't be read",
  'archive-mismatch': "the recovery bundle's copy is missing or differs",
  'unaddressable': "its name can't be read and deleted as the same object",
  'unverifiable': "it's at an attachment's encrypted name but isn't that attachment, and no other copy exists",
}

function LeftList({left}: {left: CleanerReport['left']}) {
  return <ScrollList items={left} render={item => <><Mono>{item.path}</Mono>: {LEFT_REASON[item.reason]}</>}/>
}

function RefusedList({refused}: {refused: CleanerReport['refused']}) {
  return (
    <ScrollList
      items={refused}
      render={item => (
        <><Mono>{item.path}</Mono>: refused{item.status ? ` (${item.status})` : ''}, {formatBytes(item.sealedBytes)} encrypted</>
      )}
    />
  )
}

/** Everything the conversion leaves behind, before it is declared done. */
export function FinishPromptView({prompt, answer, cancel}: {prompt: FinishPrompt; answer: () => void; cancel: () => void}) {
  const {unrecoverable, left, refused, bundleRead} = prompt
  const [accepted, setAccepted] = useState(false)
  const residue = unrecoverable.length + left.length + refused.length
  return (
    <>
      <Explanation>Every attachment on the server is encrypted, and each one checks out.</Explanation>
      {!bundleRead && (
        <Explanation>
          This run went on without the recovery bundle; nothing in it was needed. It is still what the
          workspace is restored from if the key is lost.
        </Explanation>
      )}
      {unrecoverable.length > 0 && (
        <>
          <Explanation>{unrecoverable.length} attachment(s) have no bytes anywhere and stay broken:</Explanation>
          <MediaList media={unrecoverable}/>
        </>
      )}
      {left.length > 0 && (
        <>
          <Explanation>{left.length} object(s) stay on the server as they are:</Explanation>
          <LeftList left={left}/>
        </>
      )}
      {refused.length > 0 && (
        <>
          <Explanation>{refused.length} upload(s) were refused.{raiseRemedy(refused)}</Explanation>
          <RefusedList refused={refused}/>
        </>
      )}
      {residue > 0 && (
        <ConfirmCheck id="conversion-residue-left" checked={accepted} onChange={setAccepted}>
          Finish the conversion with these left as they are.
        </ConfirmCheck>
      )}
      <Actions primary={{label: 'Finish', onClick: answer, disabled: residue > 0 && !accepted}} secondary={{label: 'Cancel', onClick: cancel}}/>
    </>
  )
}

/** Why the cleaner's proof didn't pass, and what fixes each cause. */
export function CleanupIncompleteView({report}: {report: CleanerReport}) {
  const {proof, refused, left, errors} = report
  if (proof.kind === 'passed') return null
  return (
    <>
      <Explanation>The workspace's content is encrypted, but its attachments aren't finished:</Explanation>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {proof.rawRemaining.length > 0 && (
          <li>{proof.rawRemaining.length} attachment(s) on the server aren't encrypted yet.</li>
        )}
        {refused.length > 0 && (
          <li>{refused.length} upload(s) were refused.{raiseRemedy(refused)}</li>
        )}
        {errors.length > 0 && (
          <li>{errors.length} step(s) failed on a network or server error.</li>
        )}
        {proof.archivedRemaining.length > 0 && (
          <li>
            {proof.archivedRemaining.length} object(s) the recovery bundle archived are still on the server:
            the bundle's folder couldn't be read, or its copies differ. Choose the bundle's folder on the
            next run. If the bundle is lost, they stay, and so does the conversion, since deleting them
            without a copy is never safe.
          </li>
        )}
        {proof.unverified.length > 0 && (
          <li>{proof.unverified.length} attachment(s) are missing or damaged on the server and couldn't be rebuilt.</li>
        )}
        {proof.unsettled && (
          <li>
            The attachments changed while this ran. Make sure every other device and tab with this
            workspace is closed.
          </li>
        )}
      </ul>
      {refused.length > 0 && <RefusedList refused={refused}/>}
      {left.length > 0 && (
        <>
          <Explanation>Left on the server as they are:</Explanation>
          <LeftList left={left}/>
        </>
      )}
      <Explanation>Nothing is lost. Run again once the causes above are fixed.</Explanation>
    </>
  )
}
