// Preloaded only in the idle-expiry test server. Its status waiter is the
// only timer. Keep its real delay and advance the clocks on wake, placing
// the first wake one millisecond before the scheduled wall-clock time.
const realSetTimeout = globalThis.setTimeout
let wallTime = Date.now()
let elapsed = 0
let firstWake = true

Date.now = () => wallTime
Object.defineProperty(performance, 'now', {value: () => elapsed})
globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(() => {
  const elapsedMs = Math.max(1, delay)
  wallTime += elapsedMs - Number(firstWake)
  elapsed += elapsedMs
  firstWake = false
  callback(...args)
}, delay)
