import { useEffect, useState } from 'react'

/** Follows `active` with asymmetric delays: turns on once `active` has stayed
 *  true for `enterMs`, and off once it has stayed false for `exitMs`. A flip
 *  back before a delay elapses cancels that transition, so neither a blip nor
 *  a short gap shows through. */
export function useHysteresis(active: boolean, enterMs: number, exitMs: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (active === shown) return
    const timer = setTimeout(() => setShown(active), active ? enterMs : exitMs)
    return () => clearTimeout(timer)
  }, [active, shown, enterMs, exitMs])
  return shown
}
