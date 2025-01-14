import { Editor } from '@monaco-editor/react'
import { BlockRendererProps } from '../types'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'
import type { editor } from 'monaco-editor'
import { debounce } from 'lodash'
import { useCallback } from 'react'

type MonacoEditor = editor.IStandaloneCodeEditor

const MonacoContentRenderer = ({ block }: BlockRendererProps) => {
    const blockData = block.use()
    if (!blockData) return null

    const onChange = useCallback((value: string | undefined) => {
        if (value !== undefined && value !== blockData.content) {
            block.change(doc => doc.content = value)
        }
    }, [block, blockData])
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

export const RendererBlockRenderer = (props: BlockRendererProps) => 
    <DefaultBlockRenderer {...props} ContentRenderer={MonacoContentRenderer} />
