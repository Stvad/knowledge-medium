import {Editor} from '@monaco-editor/react'
import {BlockRendererProps} from '../types'
import {DefaultBlockRenderer} from './DefaultBlockRenderer.tsx'

const MonacoContentRenderer = ({block, onUpdate}: BlockRendererProps) => {
    return <Editor
        height="400px"
        defaultLanguage="typescript"
        defaultValue={block.content}
        onChange={(value) => {
            if (value !== undefined) {
                onUpdate({...block, content: value})
            }
        }}
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
