import {useState, useEffect} from 'react'
import * as Babel from '@babel/standalone'
import {BlockRenderer, BlockRendererProps} from '../types'

import { ErrorBoundary } from 'react-error-boundary';

function FallbackComponent({ error }: { error: Error }) {
    return <div>Something went wrong: {error.message}</div>;
}

export async function wrappedComponentFromModule(code: string): Promise<BlockRenderer> {
    const Component = await componentFromModule(code);
    return (props: BlockRendererProps) => (
        <ErrorBoundary FallbackComponent={FallbackComponent}>
            {Component && <Component {...props} />}
        </ErrorBoundary>
    );
}

export async function componentFromModule(code: string): Promise<BlockRenderer> {
    try {
        const transpiledCode = Babel.transform(code, {
            filename: 'dynamic-block.tsx',
            presets: ['react', 'typescript'],
        }).code;

        if (!transpiledCode) {
            throw new Error('Transpiled code is empty');
        }

        const blob = new Blob([transpiledCode], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const module = await import(/* @vite-ignore */ blobUrl);
        
        return module.default;
    } catch (err) {
        console.error('Compilation error:', err);
        return () => (
            <div className="error">
                Failed to compile component: {err instanceof Error ? err.message : 'Unknown error'}
            </div>
        );
    }
}

export function useDynamicComponent(code: string) {
    const [DynamicComp, setDynamicComp] = useState<BlockRenderer | null>(null);

    useEffect(() => {
        async function loadComponent() {
            setDynamicComp(await wrappedComponentFromModule(code));
        }

        loadComponent();
    }, [code]);

    return  DynamicComp ;
}
