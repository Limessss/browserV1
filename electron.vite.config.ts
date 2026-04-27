/**
 * Electron-Vite 入口：对齐原仓库将主进程放在 backend/、渲染进程放在 frontend/
 */
import react from '@vitejs/plugin-react-swc'
import autoprefixer from 'autoprefixer'
import { resolve } from 'node:path'
import tailwindcss from 'tailwindcss'
import { defineConfig } from 'electron-vite'

const rootDir = __dirname

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(rootDir, 'backend/src/main/index.ts'),
      },
      outDir: resolve(rootDir, 'dist-electron/main'),
    },
    resolve: {
      alias: {
        '@backend': resolve(rootDir, 'backend/src'),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(rootDir, 'backend/src/preload/index.ts'),
      },
      outDir: resolve(rootDir, 'dist-electron/preload'),
    },
    resolve: {
      alias: {
        '@backend': resolve(rootDir, 'backend/src'),
      },
    },
  },
  renderer: {
    root: resolve(rootDir, 'frontend'),
    base: './',
    build: {
      rollupOptions: {
        input: resolve(rootDir, 'frontend/index.html'),
      },
      outDir: resolve(rootDir, 'dist-electron/renderer'),
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(rootDir, 'frontend/src'),
      },
    },
    css: {
      postcss: {
        plugins: [
          tailwindcss({ config: resolve(rootDir, 'frontend/tailwind.config.js') }),
          autoprefixer(),
        ],
      },
    },
    server: {
      port: 5218,
      strictPort: true,
      host: '127.0.0.1',
    },
  },
})
