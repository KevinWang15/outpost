import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { loopbackHost } from './shared/loopback.ts'
import { pageHtml } from './shared/pageHtml.ts'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'outpost-page-theme',
      transformIndexHtml(html, context) {
        return pageHtml(html, (context.originalUrl ?? context.path).split('?')[0])
      },
    },
    {
      name: 'outpost-loopback',
      configResolved(config) {
        if (config.command !== 'serve') return
        loopbackHost(String(config.server.host), 'VITE_HOST')
        loopbackHost(String(config.preview.host), 'VITE_HOST')
      },
    },
  ],
  build: { outDir: 'dist/client' },
  server: {
    host: loopbackHost(process.env.VITE_HOST, 'VITE_HOST'),
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000', ws: true },
      '/health': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000',
    },
  },
  preview: { host: loopbackHost(process.env.VITE_HOST, 'VITE_HOST') },
})
