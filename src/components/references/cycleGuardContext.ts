import { createContext } from 'react'

export const BlockRefAncestorsContext = createContext<ReadonlySet<string>>(new Set())
