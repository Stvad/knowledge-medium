import {defineConfig} from 'vite'
import path from "path"
import react from '@vitejs/plugin-react'
import externalize from "vite-plugin-externalize-dependencies";
import wasm from "vite-plugin-wasm"
// import noBundlePlugin from 'vite-plugin-no-bundle';

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        react(),
        wasm(),
        externalize({
            externals: [
                "react", // Externalize "react", and all of its subexports (react/*), such as react/jsx-runtime
                "react-dom",
            ],
        }),
        // noBundlePlugin(),
    ],
    resolve: {
        alias: {
          "@": path.resolve(__dirname, "./src"),
        },
      },
    build: {
        rollupOptions: {
            // Mark react and react-dom as external to rely on the import map
            external: ['react', 'react-dom'],
            output:{
                preserveModules: true, // Preserves the module structure
                // preserveModulesRoot: 'src', // Preserves the module structure
                // entryFileNames: ({ name }) => `${name}.js`, // Output file format
                // 2) This is key: specify the root directory whose relative
                //    paths you want to keep in the final output
                //    e.g. if you have 'src/components/...' then set this to 'src'.
                preserveModulesRoot: 'src',

                // 3) Remove the hash from filenames
                //    `[name].js` means the final filename is just the chunk's name
                entryFileNames: '[name].js',
                chunkFileNames: '[name].js',
                assetFileNames: '[name].[ext]',
            },
            preserveEntrySignatures: 'strict', // Preserves the signature of the entry point
        },
        sourcemap: true,
        // lib: {
        //     entry: 'src/main.tsx',
        //     name: 'OmnilinerV',
        // },
        target: 'esnext',
    },
})
