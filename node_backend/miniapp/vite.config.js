import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
    global: 'window',
  },
  optimizeDeps: {
    include: ['buffer'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  server: {
    allowedHosts: [
      '6308-185-115-4-12.ngrok-free.app',
      '9267-185-115-4-12.ngrok-free.app',
      '0948-185-115-4-12.ngrok-free.app',
      '5e7a-185-70-52-227.ngrok-free.app'
      // другие разрешённые хосты
    ],
  },
})
