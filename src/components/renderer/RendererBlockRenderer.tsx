import { Editor } from '@monaco-editor/react'
import { BlockRendererProps, BlockRenderer } from '../../types.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'
import type { editor } from 'monaco-editor'
import { debounce } from 'lodash'
import { useCallback } from 'react'
import { useData } from '@/data/block.ts'

type MonacoEditor = editor.IStandaloneCodeEditor

const MonacoContentRenderer = ({ block }: BlockRendererProps) => {
    const blockData = useData(block)
    const onChange = useCallback((value: string | undefined) => {
        if (value !== undefined && value !== blockData?.content) {
            block.change(doc => doc.content = value)
        }
    }, [block, blockData])

  if (!blockData) return null
  const debouncedOnChange = debounce(onChange, 300)

    const handleEditorMount = (editor: MonacoEditor, monaco: any) => {
        monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
            jsx: monaco.languages.typescript.JsxEmit.Preserve,
        });

        return editor.onDidBlurEditorText(() => onChange(editor.getValue()))
    }

    return (
        <div className="border rounded-md overflow-hidden">
            <Editor
                height="400px"
                defaultLanguage="typescript"
                defaultValue={blockData.content}
                defaultPath={`${blockData.id}.tsx`}
                onChange={debouncedOnChange}
                onMount={handleEditorMount}
                options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    scrollBeyondLastLine: false,
                    scrollbar: {
                        alwaysConsumeMouseWheel: false,
                    },
                    theme: 'vs-dark'
                }}
            />
        </div>
    )
}


export const RendererBlockRenderer: BlockRenderer = (props: BlockRendererProps) =>
    <DefaultBlockRenderer {...props} ContentRenderer={MonacoContentRenderer} />

RendererBlockRenderer.canRender = ({block}: BlockRendererProps) => block.dataSync()?.properties.type?.value === 'renderer'
RendererBlockRenderer.priority = () => 5
