import {Editor} from '@monaco-editor/react'
import {BlockRendererProps} from '../types'
import {DefaultBlockRenderer} from './DefaultBlockRenderer.tsx'
import type {editor as MonacoEditor} from 'monaco-editor'
import {debounce} from 'lodash'
import {useCallback} from 'react'


const MonacoContentRenderer = ({block, onUpdate}: BlockRendererProps) => {
    const onChange = useCallback((value: string) => {
        if (value !== undefined && value !== block.content) {
            onUpdate({...block, content: value})
        }
    }, [block, onUpdate])
    const debouncedOnChange = debounce(onChange, 300)

    const handleEditorMount = (editor: MonacoEditor) =>
        editor.onDidBlurEditorText(() => onChange(editor.getValue()))

    return <Editor
        height="400px"
        defaultLanguage="typescript"
        defaultValue={block.content}
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
