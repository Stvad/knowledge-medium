import {BlockProperties as BlockPropertiesType, Block} from '../types'

interface BlockPropertiesProps {
    block: Block;
    show: boolean;
    onChange: (properties: BlockPropertiesType) => void;
}

export function BlockProperties({ block, show, onChange }: BlockPropertiesProps) {
    const properties = block.properties || {};
    return (
        <div className={`block-properties ${show ? '' : 'hidden'}`}>
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
                                e.preventDefault();
                                const newKey = e.currentTarget.value;
                                if (newKey && newKey !== key) {
                                    const newProps = { ...properties };
                                    delete newProps[key];
                                    newProps[newKey] = value;
                                    onChange(newProps);
                                }
                            }
                        }}
                        onBlur={(e) => {
                            const newKey = e.target.value;
                            if (newKey && newKey !== key) {
                                const newProps = { ...properties };
                                delete newProps[key];
                                newProps[newKey] = value;
                                onChange(newProps);
                            }
                        }}
                    />
                    <input
                        className="value"
                        type="text"
                        value={value}
                        onChange={(e) => {
                            onChange({
                                ...properties,
                                [key]: e.target.value,
                            });
                        }}
                    />
                </div>
            ))}
            <button
                onClick={() => {
                    onChange({
                        ...properties,
                        [`property${Object.keys(properties).length + 1}`]: '',
                    });
                }}
            >
                Add Property
            </button>
        </div>
    );
}
