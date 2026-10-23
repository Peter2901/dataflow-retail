import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const page = p => fileURLToPath(new URL(p, import.meta.url))

// Pages: the store app (index.html) and the light owner view (owner.html).
// `vite build --mode mobile` builds the full store app for the Android phone app (no billing counter).
// `vite build --mode owner` builds only the light owner view.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  build: {
    chunkSizeWarningLimit: 4000,
    outDir: mode === 'owner' ? 'dist-owner' : mode === 'mobile' ? 'dist-mobile' : mode === 'stress' ? 'dist-stress' : 'dist',
    rollupOptions: {
      input: mode === 'owner'
        ? { owner: page('./owner.html') }
        : mode === 'mobile' || mode === 'stress' ? { main: page('./index.html') }
        : { main: page('./index.html'), owner: page('./owner.html') },
    },
  },
}))
