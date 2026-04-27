import { useMemo } from 'react'
import { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { BlockEditor } from '@/components/BlockEditor.tsx'
import { createTypeScriptConfig } from '@/utils/codemirror.ts'
import { useExtensionLoadError } from '@/extensions/extensionLoadErrors.tsx'

const ExtensionLoadErrorBanner = ({error}: {error: Error}) => (
  <div
    role="alert"
    data-testid="extension-load-error"
    className="border border-red-500/60 bg-red-500/10 text-red-200 rounded-md px-3 py-2 mb-2 text-sm font-mono whitespace-pre-wrap"
  >
    <strong className="font-semibold">Extension failed to load:</strong>
    {' '}
    {error.message}
  </div>
)

const ExtensionEditor = ({block}: BlockRendererProps) => {
  const extensions = useMemo(() => createTypeScriptConfig(), [])
  const error = useExtensionLoadError(block.id)

  return (
    <div>
      {error && <ExtensionLoadErrorBanner error={error}/>}
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
    </div>
  )
}

export const CodeMirrorExtensionBlockRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <DefaultBlockRenderer {...props} EditContentRenderer={ExtensionEditor}/>

CodeMirrorExtensionBlockRenderer.canRender = ({block}: BlockRendererProps) =>
  block.dataSync()?.properties.type?.value === 'extension'
CodeMirrorExtensionBlockRenderer.priority = () => 5
