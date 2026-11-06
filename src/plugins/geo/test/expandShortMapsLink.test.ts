import { describe, expect, it, vi } from 'vitest'
import { expandShortMapsLink } from '../expandShortMapsLink'
import { MapsLinkError } from '../resolveMapsLink'

const SHORT = 'https://maps.app.goo.gl/abc'
const FULL = 'https://www.google.com/maps/place/X/data=!3d1!4d2'

const fakeClient = () => {
  const invoke = vi.fn(async () => ({data: {url: FULL}, error: null}))
  return {client: {functions: {invoke}} as unknown as NonNullable<Parameters<typeof expandShortMapsLink>[1]>['client'], invoke}
}

describe('expandShortMapsLink', () => {
  it('asks the edge function when the session syncs', async () => {
    const {client, invoke} = fakeClient()
    expect(await expandShortMapsLink(SHORT, {client, remoteSync: true})).toBe(FULL)
    expect(invoke).toHaveBeenCalledWith('resolve-maps-link', {body: {url: SHORT}})
  })

  it('sends nothing to the server in a local-only session', async () => {
    const {client, invoke} = fakeClient()
    await expect(expandShortMapsLink(SHORT, {client, remoteSync: false})).rejects.toBeInstanceOf(MapsLinkError)
    expect(invoke).not.toHaveBeenCalled()
  })
})
