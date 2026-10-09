import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'node:fs'

const assFiles = ['subtitles-octopus.js', 'subtitles-octopus-worker.js', 'subtitles-octopus-worker.wasm', 'COPYRIGHT']
const assRoot = path.resolve(__dirname, 'node_modules/libass-wasm/dist/js')

export default defineConfig({
  plugins: [react(), {
    name: 'local-ass-renderer',
    generateBundle() {
      for (const file of assFiles) this.emitFile({ type: 'asset', fileName: `ass-renderer/4.1.0/${file}`, source: fs.readFileSync(path.join(assRoot, file)) })
    },
    configureServer(server) {
      server.middlewares.use('/ass-renderer/4.1.0', (req, res, next) => {
        const file = (req.url || '').replace(/^\//, '').split('?')[0]
        if (!assFiles.includes(file)) return next()
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : file.endsWith('.js') ? 'application/javascript' : 'text/plain')
        res.end(fs.readFileSync(path.join(assRoot, file)))
      })
    },
  }],
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
