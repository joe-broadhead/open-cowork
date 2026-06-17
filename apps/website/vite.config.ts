import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/react-client.tsx'),
      output: {
        format: 'es',
        entryFileNames: 'open-cowork-cloud-react.js',
        // Split React/ReactDOM/scheduler into a fixed-name vendor chunk that the
        // entry imports — cacheable across app deploys, and smaller initial app
        // chunk. Fixed (un-hashed) names keep the pipeline simple: the SSR shell
        // loads only the entry <script>, the entry imports the vendor chunk, and
        // build-cloud copies the whole client dir so every chunk ships.
        chunkFileNames: 'open-cowork-cloud-react-[name].js',
        manualChunks: (id) => (/node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'vendor' : undefined),
      },
    },
  },
})
