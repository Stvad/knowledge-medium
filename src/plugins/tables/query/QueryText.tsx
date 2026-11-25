import { BlockReadText } from '@/components/renderer/BlockReadText'
import type { PropertyEditorProps } from '@/data/api'
import { Block } from '@/data/block'

/** Render query syntax literally, including punctuation inside quoted values. */
export const QueryText = ({value, block}: PropertyEditorProps<string>) => block instanceof Block
  ? <BlockReadText block={block} className="font-mono">{value}</BlockReadText>
  : <span className="whitespace-pre-wrap font-mono">{value}</span>
