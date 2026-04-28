import { useMemo, useRef, MouseEvent, TouchEvent } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { BlockEditor } from '@/components/BlockEditor.tsx'
import { createTypeScriptConfig } from '@/utils/codemirror.ts'
import { useExtensionLoadError } from '@/extensions/extensionLoadErrors.tsx'
import { useData } from '@/hooks/block.ts'
import { useBlockContentGestureHandlers } from '@/extensions/blockInteractionContext.tsx'

type Touch = { x: number; y: number; time: number }

const isSwipe = (a: Touch, b: Touch) =>
  Math.abs(a.x - b.x) > 10 || Math.abs(a.y - b.y) > 10 || (a.time - b.time) > 300

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

const ExtensionViewer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  const extensions = useMemo(() => createTypeScriptConfig(), [])
  const error = useExtensionLoadError(block.id)
  const contentGestureHandlers = useBlockContentGestureHandlers()

  const touchStartRef = useRef<Touch | null>(null)

  const handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length > 0) {
      const touch = e.touches[0]
      touchStartRef.current = {x: touch.clientX, y: touch.clientY, time: Date.now()}
    }
  }

  const handleTouchEnd = (e: TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length === 0) return
    const touch = e.changedTouches[0]
    const touchEnd = {x: touch.clientX, y: touch.clientY, time: Date.now()}
    if (!isSwipe(touchEnd, touchStartRef.current)) {
      void contentGestureHandlers.onTap?.(e)
    }
    touchStartRef.current = null
  }

  if (!blockData) return null

  return (
    <div>
      {error && <ExtensionLoadErrorBanner error={error}/>}
      <div
        className="border rounded-md overflow-hidden"
        onMouseDownCapture={(e: MouseEvent) => {
          // detail === 2 catches double-click before native text-selection kicks in
          if (e.detail !== 2) return
          void contentGestureHandlers.onDoubleClick?.(e)
        }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <CodeMirror
          value={blockData.content}
          extensions={extensions}
          editable={false}
          theme="dark"
          className="w-full"
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            history: false,
          }}
        />
      </div>
    </div>
  )
}

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
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={ExtensionViewer}
    EditContentRenderer={ExtensionEditor}
  />

CodeMirrorExtensionBlockRenderer.canRender = ({block}: BlockRendererProps) =>
  block.dataSync()?.properties.type?.value === 'extension'
CodeMirrorExtensionBlockRenderer.priority = () => 5
