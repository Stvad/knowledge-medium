// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceConversionRead } from '@/sync/keys/conversionState'
import type { Workspace } from '@/types'
import { EncryptionSection } from './EncryptionSection'

const h = vi.hoisted(() => ({reads: [] as WorkspaceConversionRead[]}))
vi.mock('@/data/workspaceConversion', () => ({fetchWorkspaceConversionState: async () => h.reads.shift()}))

const USER = 'owner-1'
const workspace = {id: 'ws', name: 'Vault', encryptionMode: 'e2ee'} as Workspace

afterEach(cleanup)

describe('EncryptionSection', () => {
  it('offers to check again when the server read fails, instead of hiding an unfinished conversion', async () => {
    h.reads = [
      {kind: 'unavailable', error: new Error('offline')},
      {kind: 'read', state: {encryptionMode: 'e2ee', conversionPhase: 'cleaning', wkCanary: 'enc:v1:canary', ownerUserId: USER}} as WorkspaceConversionRead,
    ]
    render(<EncryptionSection workspace={workspace} userId={USER} onStart={() => {}}/>)

    fireEvent.click(await screen.findByRole('button', {name: 'Check again'}))

    expect(await screen.findByRole('button', {name: 'Finish the conversion…'})).toBeTruthy()
  })
})
