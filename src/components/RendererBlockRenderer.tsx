import {useState} from 'react'
import {Editor} from '@monaco-editor/react'
import {BlockRendererProps} from '../types'
import {DynamicBlockRenderer} from './DynamicBlockRenderer'


export function RendererBlockRenderer({block, onUpdate}: BlockRendererProps) {
    const [isEditing, setIsEditing] = useState(true)

    // ${block.properties.type === 'renderer' ? 'custom-block' : ''}

    return (
        <>
            {isEditing ? (
                <Editor
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
            ) : (
                <div className="block-content">
                    <DynamicBlockRenderer code={block.content} block={block}/>
                </div>
            )}
        </>
    )
}
