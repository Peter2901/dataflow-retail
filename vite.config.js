import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const page = p => fileURLToPath(new URL(p, import.meta.url))

// Two pages: the store app (index.html) and the owner phone app (owner.html).
// `vite build --mode owner` builds only the owner app, for the Android APK.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  build: {
    chunkSizeWarningLimit: 4000,
    outDir: mode === 'owner' ? 'dist-owner' : 'dist',
    rollupOptions: {
      input: mode === 'owner'
        ? { owner: page('./owner.html') }
        : { main: page('./index.html'), owner: page('./owner.html') },
    },
  },
}))
