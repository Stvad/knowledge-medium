import { useState, useEffect } from 'react';
import * as Babel from '@babel/standalone';



export function useDynamicComponent(code: string) {
    const [DynamicComp, setDynamicComp] = useState<React.ComponentType | null>(null);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        async function compileAndRender() {
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
                setDynamicComp(() => module.default);
                setError(null);
            } catch (err) {
                console.error('Compilation error:', err);
                setError(err instanceof Error ? err : new Error('Unknown error'));
                setDynamicComp(null);
            }
        }

        compileAndRender();
    }, [code]);

    return { DynamicComp, error };
}
