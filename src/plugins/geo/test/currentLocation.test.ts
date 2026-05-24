import { describe, expect, it } from 'vitest'
import {
  CurrentLocationError,
  getCurrentPosition,
} from '../currentLocation'

interface FakeGeoOptions {
  successPos?: {coords: {latitude: number; longitude: number; accuracy: number}}
  errorCode?: number
  errorMessage?: string
  /** When true, never invokes either callback — to simulate hang for
   *  the (separate) timeout test. */
  hang?: boolean
}

const fakeNavigator = (opts: FakeGeoOptions): Partial<Navigator> => ({
  geolocation: {
    getCurrentPosition: (success, error) => {
      if (opts.hang) return
      if (opts.successPos) success(opts.successPos as GeolocationPosition)
      else if (opts.errorCode !== undefined) {
        error?.({
          code: opts.errorCode,
          message: opts.errorMessage ?? '',
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
        } as GeolocationPositionError)
      }
    },
    watchPosition: () => 0,
    clearWatch: () => {},
  } as Geolocation,
})

describe('getCurrentPosition', () => {
  it('resolves with {lat, lng, accuracy} on success', async () => {
    const result = await getCurrentPosition({
      navigator: fakeNavigator({
        successPos: {coords: {latitude: 37.76, longitude: -122.42, accuracy: 18}},
      }),
    })
    expect(result).toEqual({lat: 37.76, lng: -122.42, accuracy: 18})
  })

  it('rejects with kind="denied" when the user blocks permission', async () => {
    await expect(getCurrentPosition({
      navigator: fakeNavigator({errorCode: 1, errorMessage: 'denied'}),
    })).rejects.toMatchObject({
      name: 'CurrentLocationError',
      kind: 'denied',
    })
  })

  it('rejects with kind="unavailable" when position is unavailable', async () => {
    await expect(getCurrentPosition({
      navigator: fakeNavigator({errorCode: 2}),
    })).rejects.toMatchObject({
      name: 'CurrentLocationError',
      kind: 'unavailable',
    })
  })

  it('rejects with kind="timeout" when geolocation times out', async () => {
    await expect(getCurrentPosition({
      navigator: fakeNavigator({errorCode: 3}),
    })).rejects.toMatchObject({
      name: 'CurrentLocationError',
      kind: 'timeout',
    })
  })

  it('rejects with kind="unsupported" when navigator.geolocation is missing', async () => {
    await expect(getCurrentPosition({
      navigator: {} as Partial<Navigator>,
    })).rejects.toMatchObject({
      name: 'CurrentLocationError',
      kind: 'unsupported',
    })
  })

  it('typed CurrentLocationError is an instance check', async () => {
    try {
      await getCurrentPosition({navigator: fakeNavigator({errorCode: 1})})
      expect.fail('should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(CurrentLocationError)
    }
  })
})
