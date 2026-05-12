import { useContext } from 'react'
import { BlockRefAncestorsContext } from './cycleGuardContext'

export const useBlockRefAncestors = () => useContext(BlockRefAncestorsContext)
