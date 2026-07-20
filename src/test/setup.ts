import { setDevAssertionsEnabled } from '@/data/internals/devAssertions'

// jest-dom's matchers only matter where a DOM exists; loading it in the ~370
// node-env files costs ~23ms each of pure setup-phase waste. The /vitest entry
// (unlike the bare package, whose types are a non-module global script) is
// dynamic-import-friendly and registers the matchers on vitest's expect.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest')
}

// L2 data-integrity invariant assertions run in every test (they hard-throw on a
// derived-data contract violation — see docs/data-integrity-defense.html L2).
setDevAssertionsEnabled(true)

// Add any global test setup here
