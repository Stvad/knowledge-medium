/** Commands that tag the focused block, or every selected block, with a
 *  counter type, so the counter is reachable from the command palette as well
 *  as the `#` autocomplete. Each type's initial values come with the tag. */

import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { getBlockTypes } from '@/data/properties'
import { defineBlocksAction } from '@/shortcuts/utils.js'
import { CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE } from './blockType'

const lacksType = (typeId: string) => (block: Block): boolean => {
  const data = block.peek()
  return !data || !getBlockTypes(data).includes(typeId)
}

const addTypeToBlocks = (typeId: string) => async (blocks: readonly Block[]): Promise<void> => {
  const repo = blocks[0]?.repo
  if (!repo || repo.isReadOnly) return
  await repo.tx(async tx => {
    for (const block of blocks) await repo.addTypeInTx(tx, block.id, typeId)
  }, {scope: ChangeScope.BlockDefault, description: `add ${typeId}`})
}

const addCounterAction = (typeId: string, id: string, name: string) => defineBlocksAction({
  id,
  blockDescription: `Add ${name}`,
  blocksDescription: `Add ${name} to selected blocks`,
  appliesTo: lacksType(typeId),
  flow: addTypeToBlocks(typeId),
})

export const addCharacterCounterAction =
  addCounterAction(CHAR_COUNTER_TYPE, 'character-counter.add-char-counter', 'character counter')
export const addWordCounterAction =
  addCounterAction(WORD_COUNTER_TYPE, 'character-counter.add-word-counter', 'word counter')

export const counterActions = [addCharacterCounterAction, addWordCounterAction]
  .flatMap(pair => [pair.block, pair.blocks])
