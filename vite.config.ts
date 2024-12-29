import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import externalize from "vite-plugin-externalize-dependencies";
// import {dynamicImportWithImportMap} from '@kanamone/vite-plugin-dynamic-import-with-import-map'

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        react(),
        externalize({
            externals: [
                "react", // Externalize "react", and all of its subexports (react/*), such as react/jsx-runtime
                "react-dom", // Externalize "react-dom", and all of its subexports (react-dom/*), such as react-dom/server
            ],
        }),
        // dynamicImportWithImportMap(['react', 'react-dom']),
    ],
    build: {
        rollupOptions: {
            // Mark react and react-dom as external to rely on the import map
            external: ['react', 'react-dom'],
        },
    },
})