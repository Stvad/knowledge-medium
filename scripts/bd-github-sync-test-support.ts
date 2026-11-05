// Fixtures shared by the bd-github-sync test files.
// Not a test file itself: vitest collects only *.test.ts.

// The thread-resolve mutation the graphql cases share: its one variable is an ID.
export const RESOLVE = 'mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id}}}'
