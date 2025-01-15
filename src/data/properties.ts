import { Block } from '@/data/block.ts'

export const useIsEditing = (block: Block) => {
  return block.useProperty<boolean>('system:isEditing', false)
}
