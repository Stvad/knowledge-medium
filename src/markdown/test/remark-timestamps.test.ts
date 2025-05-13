import { expect, it, describe, afterEach } from 'vitest'
import { TS_RE } from '../remark-timestamps'

describe('timestamp regex', () => {
  afterEach(() => {
    // apparently running .test on /g regex mutates it =\
    TS_RE.lastIndex = 0
  })
  it.each(['0:30', '1:23', '12:34', '1:23:45', '10:03:04.500'])(
    '%s should match',
    (str) => expect(TS_RE.test(str)).toBe(true)
  );
});
