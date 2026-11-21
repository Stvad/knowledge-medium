// Extensions are loaded as ES modules in the browser, so a bare `https://…`
// specifier is a legitimate import (matrix-chat-client.tsx pulls matrix-js-sdk
// straight off esm.sh). TypeScript has no way to resolve one, so declare the
// shape as `any` rather than leaving a permanent TS2307 in the flat typecheck.
//
// This is a real hole: nothing type-checks a URL-imported dependency. Prefer a
// `@/…` import when the app already bundles the thing you need.
declare module 'https://*' {
  const value: any
  export = value
}
