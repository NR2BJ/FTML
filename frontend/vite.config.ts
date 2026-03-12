import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return
          }
          if (id.includes('react-router-dom')) {
            return 'router'
          }
          if (id.includes('hls.js')) {
            return 'media'
          }
          if (id.includes('lucide-react')) {
            return 'icons'
          }
          if (id.includes('axios') || id.includes('zustand')) {
            return 'data'
          }
          if (id.includes('/react/') || id.includes('react-dom') || id.includes('scheduler')) {
            return 'react-vendor'
          }
          return 'vendor'
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
})
