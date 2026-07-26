import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@round/rtc-core': path.resolve(currentDirectory, '../../packages/rtc-core/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/healthz': 'http://localhost:8787',
      '/signal': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
});
