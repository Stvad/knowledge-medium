import { useEffect, useState } from 'react'

/** Returns `value` delayed by `delayMs`, collapsing rapid changes into a
 *  single trailing update — for debouncing a search query before firing
 *  the request. The first value is returned immediately; subsequent
 *  changes wait out `delayMs` of quiet. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
