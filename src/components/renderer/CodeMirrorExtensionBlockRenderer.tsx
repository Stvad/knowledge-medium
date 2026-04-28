import { useMemo, ReactNode } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { BlockEditor } from '@/components/BlockEditor.tsx'
import { createTypeScriptConfig } from '@/utils/codemirror.ts'
import { useExtensionLoadError } from '@/extensions/extensionLoadErrors.tsx'
import { useData } from '@/hooks/block.ts'

const extensionFrameClass = 'border rounded-md overflow-hidden'
const extensionTheme = 'dark'
const extensionBasicSetup = {history: false}

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

const ExtensionFrame = ({blockId, children}: {blockId: string; children: ReactNode}) => {
  const error = useExtensionLoadError(blockId)
  return (
    <div>
      {error && <ExtensionLoadErrorBanner error={error}/>}
      <div className={extensionFrameClass}>{children}</div>
    </div>
  )
}

const ExtensionViewer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  const extensions = useMemo(() => createTypeScriptConfig(), [])

  if (!blockData) return null

  return (
    <ExtensionFrame blockId={block.id}>
      <CodeMirror
        value={blockData.content}
        extensions={extensions}
        editable={false}
        theme={extensionTheme}
        className="w-full"
        basicSetup={extensionBasicSetup}
      />
    </ExtensionFrame>
  )
}

const ExtensionEditor = ({block}: BlockRendererProps) => {
  const extensions = useMemo(() => createTypeScriptConfig(), [])

  return (
    <ExtensionFrame blockId={block.id}>
      <BlockEditor
        block={block}
        extensions={extensions}
        theme={extensionTheme}
        className="w-full"
        basicSetup={extensionBasicSetup}
        indentWithTab={true}
        autoFocus={false}
      />
    </ExtensionFrame>
  )
}

export const CodeMirrorExtensionBlockRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={ExtensionViewer}
    EditContentRenderer={ExtensionEditor}
  />

CodeMirrorExtensionBlockRenderer.canRender = ({block}: BlockRendererProps) =>
  block.dataSync()?.properties.type?.value === 'extension'
CodeMirrorExtensionBlockRenderer.priority = () => 5
