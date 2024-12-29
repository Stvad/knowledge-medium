import { BlockProperties as BlockPropertiesType } from '../types';

interface BlockPropertiesProps {
    properties: BlockPropertiesType;
    show: boolean;
    onChange: (properties: BlockPropertiesType) => void;
}

export function BlockProperties({ properties, show, onChange }: BlockPropertiesProps) {
    return (
        <div className={`block-properties ${show ? '' : 'hidden'}`}>
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
