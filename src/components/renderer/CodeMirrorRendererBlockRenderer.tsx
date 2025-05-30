import { BlockRendererProps, BlockRenderer } from '../../types.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'
import { useMemo } from 'react'
import { createTypeScriptConfig } from '@/utils/codemirror.ts'
import { BlockEditor } from '@/components/BlockEditor.tsx'

const TypescriptBlockEditor = ({ block }: BlockRendererProps) => {
  const extensions = useMemo(() => createTypeScriptConfig(), [])

  return (
    <div className="border rounded-md overflow-hidden">
      <BlockEditor
        block={block}
        extensions={extensions}
        theme="dark"
        className="w-full"
        basicSetup={{
          history: false,
        }}
        indentWithTab={true}
        autoFocus={false}
      />
    </div>
  )
}

export const CodeMirrorRendererBlockRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <DefaultBlockRenderer {...props} EditContentRenderer={TypescriptBlockEditor} />

CodeMirrorRendererBlockRenderer.canRender = ({block}: BlockRendererProps) => 
  block.dataSync()?.properties.type?.value === 'renderer'
CodeMirrorRendererBlockRenderer.priority = () => 5
