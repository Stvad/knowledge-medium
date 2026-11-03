/**
 * Property: `isSealedValue` accepts exactly the strings the server's
 * `public.is_enc_v1_envelope` does. The oracle is the regex read from the
 * migration itself, run on values short enough not to overflow V8's
 * backtracking stack. See `src/test/fuzz.ts` for the smoke/deep tiers.
 */
import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { isSealedValue } from './sealing.js'

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260529120000_add_e2ee_workspace_columns.sql', import.meta.url),
  'utf8',
)
const serverShape = new RegExp(/select v ~ '([^']+)'/.exec(migration)![1])

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const base64url = fc.constantFrom(...BASE64URL)
/** Payloads around the 38-character floor, where the length rules bite. */
const payloadArb = fc.oneof(
  fc.string({unit: base64url, maxLength: 60}),
  fc.integer({min: 34, max: 46}).chain(length => fc.string({unit: base64url, minLength: length, maxLength: length})),
)
const valueArb = fc.tuple(
  fc.constantFrom('enc:v1:', 'enc:v1:', 'enc:v2:', ''),
  payloadArb,
  fc.constantFrom('', '', '', '=', '+', '/', ' ', '\n', 'é'),
).map(([prefix, payload, tail]) => prefix + payload + tail)

describe('isSealedValue (property)', () => {
  it('agrees with the server\'s is_enc_v1_envelope', () => {
    fc.assert(
      fc.property(valueArb, value => {
        expect(isSealedValue(value)).toBe(serverShape.test(value))
      }),
      fuzzParams(500),
    )
  }, fuzzTestTimeout())
})
