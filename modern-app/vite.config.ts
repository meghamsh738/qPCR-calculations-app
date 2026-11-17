import path from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ROOT_DIR = path.resolve(__dirname, '..')
const DIST_DIR = path.join(ROOT_DIR, '.app-dist', 'web')
const moduleRequire = createRequire(import.meta.url)
const runtime = moduleRequire(path.join(ROOT_DIR, 'desktop', 'electron', 'next-runtime.cjs'))

if (process.env.APP_DIST_DIR) {
  throw new Error('APP_DIST_DIR cannot redirect an EasyLab Next calculator build.')
}
if (process.env.VITE_API_BASE) {
  throw new Error('VITE_API_BASE cannot override the qPCR Planner Next API address.')
}
if (process.argv.some((argument) => argument === '--outDir' || argument.startsWith('--outDir=') || argument === '--root')) {
  throw new Error('EasyLab Next calculator builds use only their checked-in output and source paths.')
}
runtime.assertNoSymlinkPathComponents(DIST_DIR)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  envDir: false,
  define: {
    'import.meta.env.VITE_API_BASE': JSON.stringify('http://127.0.0.1:18512'),
  },
  build: {
    outDir: DIST_DIR,
    emptyOutDir: true,
    copyPublicDir: false,
  },
  server: {
    host: '127.0.0.1',
    port: 19512,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 19512,
    strictPort: true,
  },
})
