import { ErrorBoundary } from 'react-error-boundary';
import { useDynamicComponent } from '../hooks/useDynamicComponent';

function FallbackComponent({ error }: { error: Error }) {
    return <div>Something went wrong: {error.message}</div>;
}

export function DynamicBlockRenderer({ code }: { code: string }) {
    const  DynamicComp  = useDynamicComponent(code);

    return (
        <ErrorBoundary FallbackComponent={FallbackComponent}>
            {DynamicComp && <DynamicComp />}
        </ErrorBoundary>
    );
}
