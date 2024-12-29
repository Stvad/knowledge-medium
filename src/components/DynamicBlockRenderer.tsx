import {ErrorBoundary} from 'react-error-boundary'
import {useDynamicComponent} from '../hooks/useDynamicComponent'
import {Block} from '../types.ts'

function FallbackComponent({error}: { error: Error }) {
    return <div>Something went wrong: {error.message}</div>
}

export function DynamicBlockRenderer({code, block}: { code: string, block: Block }) {
    const DynamicComp = useDynamicComponent(code)

    return (
        <ErrorBoundary FallbackComponent={FallbackComponent}>
            {DynamicComp && <DynamicComp onUpdate={() => {
            }} block={block}/>}
        </ErrorBoundary>
    )
}
