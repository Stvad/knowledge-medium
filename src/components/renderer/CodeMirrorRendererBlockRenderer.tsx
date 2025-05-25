import CodeMirror from '@uiw/react-codemirror'
import { BlockRendererProps, BlockRenderer } from '../../types.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'
import { useCallback, useMemo } from 'react'
import { debounce } from 'lodash'
import { useData } from '@/data/block.ts'
import { createTypeScriptConfig } from '@/utils/codemirror.ts'
import { updateText } from '@automerge/automerge/next'

const CodeMirrorMonacoReplacement = ({ block }: BlockRendererProps) => {
  const blockData = useData(block)
  const extensions = useMemo(() => createTypeScriptConfig(), [])
  
  const onChange = useCallback((value: string) => {
    if (value !== blockData?.content) {
      block.change(b => updateText(b, ['content'], value))
    }
  }, [block, blockData])

  const debouncedOnChange = useMemo(() => debounce(onChange, 300), [onChange])

  if (!blockData) return null

  return (
    <div className="border rounded-md overflow-hidden">
      <CodeMirror
        value={blockData.content || ''}
        onChange={debouncedOnChange}
        extensions={extensions}
        height="400px"
        theme="dark"
      />
    </div>
  )
}

export const CodeMirrorRendererBlockRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <DefaultBlockRenderer {...props} ContentRenderer={CodeMirrorMonacoReplacement} />

CodeMirrorRendererBlockRenderer.canRender = ({block}: BlockRendererProps) => 
  block.dataSync()?.properties.type?.value === 'renderer'
CodeMirrorRendererBlockRenderer.priority = () => 5
