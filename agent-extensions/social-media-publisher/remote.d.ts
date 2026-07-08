declare module 'https://esm.sh/@atproto/api@0.19.3?bundle' {
  export const AtpAgent: any
  export const RichText: any
}

declare module 'https://esm.sh/twitter-text@3.1.0?bundle' {
  export function parseTweet(text: string): {weightedLength: number}
}
