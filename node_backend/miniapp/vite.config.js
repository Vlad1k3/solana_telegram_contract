import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
    proxy: {
      '/contracts': 'http://localhost:3000',
      '/users': 'http://localhost:3000'
    },
    allowedHosts: [
      '6308-185-115-4-12.ngrok-free.app',
      '9267-185-115-4-12.ngrok-free.app',
      '0948-185-115-4-12.ngrok-free.app',
      '5e7a-185-70-52-227.ngrok-free.app',
      '5db5eafcfda4.ngrok-free.app',
      'b394e2598c9e.ngrok-free.app'
    ],
  },
})