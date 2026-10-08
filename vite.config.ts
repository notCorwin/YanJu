import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  base: '/YanJu/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'ai', test: /node_modules\/(?:ai|@ai-sdk\/(?:provider|provider-utils))\// },
            { name: 'schema', test: /node_modules\/zod\// },
            { name: 'react', test: /node_modules\/(?:react|react-dom|scheduler)\// },
            { name: 'storage', test: /node_modules\/(?:dexie|dexie-react-hooks)\// },
          ],
        },
      },
    },
  },
})
