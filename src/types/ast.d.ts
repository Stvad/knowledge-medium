import {Literal} from 'mdast';

export interface Timestamp extends Literal {
  type: 'timestamp';
  data: {
    hName: 'time-stamp';  // hint for mdast‑to‑hast
    hProperties: {hms: string};
    hChildren: [{type: 'text'; value: string}];
  };
}

declare module 'mdast' {
  interface RootContentMap { timestamp: Timestamp }
}
