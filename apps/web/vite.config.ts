import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ConfigEnv, type UserConfig } from 'vite';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../..');

export function createViteConfig({ mode }: ConfigEnv): UserConfig {
  const environment = loadEnv(mode, repositoryRoot, '');
  const signalingPort = environment.PORT?.trim() || '8787';

  return {
    plugins: [react()],
    envDir: repositoryRoot,
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
        '/api': {
          target: `http://127.0.0.1:${signalingPort}`,
          changeOrigin: true,
          xfwd: true,
        },
        '/healthz': `http://127.0.0.1:${signalingPort}`,
        '/signal': {
          target: `ws://127.0.0.1:${signalingPort}`,
          ws: true,
        },
      },
    },
  };
}

export default defineConfig(createViteConfig);
