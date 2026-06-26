import '@testing-library/jest-dom'
import { setDevAssertionsEnabled } from '@/data/internals/devAssertions'

// L2 data-integrity invariant assertions run in every test (they hard-throw on a
// derived-data contract violation — see docs/data-integrity-defense.html L2).
setDevAssertionsEnabled(true)

// Add any global test setup here
