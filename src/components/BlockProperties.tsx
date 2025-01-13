import {BlockProperties as BlockPropertiesType, Block} from '../types'

interface BlockPropertiesProps {
    block: Block;
    changeProps: (changeFn: (properties: BlockPropertiesType) => void) => void;
}

export function BlockProperties({block, changeProps}: BlockPropertiesProps) {
    const properties = block.properties || {}
    const updateKey = (newKey: string, key: string, value: string | undefined) => {
        if (newKey && newKey !== key) {
            changeProps(properties => {
                delete properties[key]
                properties[newKey] = value
            })
        }
    }
    return (
        <div className={`block-properties`}>
            <div className="property-row">
                <input
                    className="key"
                    type="text"
                    value="id"
                    disabled
                />
                <input
                    className="value"
                    type="text"
                    value={block.id || ''}
                    disabled
                />
            </div>
            {Object.entries(properties).map(([key, value]) => (
                <div key={key} className="property-row">
                    <input
                        className="key"
                        type="text"
                        defaultValue={key}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                updateKey(e.currentTarget.value, key, value)
                            }
                        }}
                        onBlur={(e) => {
                            updateKey(e.target.value, key, value)
                        }}
                    />
                    <input
                        className="value"
                        type="text"
                        value={value}
                        onChange={(e) => {
                            //todo debounce
                            changeProps(properties => {
                                properties[key] = e.target.value
                            })
                        }}
                    />
                </div>
            ))}
            <button
                onClick={() => {
                    changeProps(properties => {
                        properties[`property${Object.keys(properties).length + 1}`] = ''
                    })
                }}
            >
                Add Property
            </button>
        </div>
    )
}
