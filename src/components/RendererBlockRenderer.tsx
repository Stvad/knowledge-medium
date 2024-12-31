import {Editor} from '@monaco-editor/react'
import {BlockRendererProps} from '../types'
import {DefaultBlockRenderer} from './DefaultBlockRenderer.tsx'
import type {editor} from 'monaco-editor'
import {debounce} from 'lodash'
import {useCallback} from 'react'

type MonacoEditor = editor.IStandaloneCodeEditor

const MonacoContentRenderer = ({block, onUpdate}: BlockRendererProps) => {
    const onChange = useCallback((value: string | undefined) => {
        if (value !== undefined && value !== block.content) {
            onUpdate({...block, content: value})
        }
    }, [block, onUpdate])
    const debouncedOnChange = debounce(onChange, 300)

    const handleEditorMount = (editor: MonacoEditor, monaco: any) => {
        monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
            //todo unclear if this is the correct  option
            jsx: monaco.languages.typescript.JsxEmit.Preserve,
        });

        return editor.onDidBlurEditorText(() => onChange(editor.getValue()))
    }

    // supplying the path is a bit sus bc if there is name collision - monaco would treat these as one editor
    return <Editor
        height="400px"
        defaultLanguage="typescript"
        defaultValue={block.content}
        defaultPath={`${block.id}.tsx`}
        onChange={debouncedOnChange}
        onMount={handleEditorMount}
        options={{
            minimap: {enabled: false},
            fontSize: 14,
            scrollBeyondLastLine: false,
        }}
    />
}


export const RendererBlockRenderer = ({block, onUpdate}: BlockRendererProps) =>
    <DefaultBlockRenderer
        block={block}
        onUpdate={onUpdate}
        ContentRenderer={MonacoContentRenderer}/>
