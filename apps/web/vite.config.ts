import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The build output (dist/) is served as static assets by the Worker — there is
// no separate frontend deploy. See DEVELOPMENT.md → "one Worker, not two deploys".
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
