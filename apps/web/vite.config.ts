import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type ConfigEnv, type UserConfig } from 'vite';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(currentDirectory, '../..');

export function rewriteBatonRoomEndpoint(requestPath: string): string {
  return requestPath
    .replace(/^\/round\/rooms\/([^/?#]+)\/signal(?=$|[?#])/, '/rooms/$1/signal')
    .replace(
      /^\/round\/rooms\/([^/?#]+)\/turn-credentials(?=$|[?#])/,
      '/api/rooms/$1/turn-credentials',
    );
}

export function createViteConfig({ mode }: ConfigEnv): UserConfig {
  const environment = loadEnv(mode, repositoryRoot, '');
  const signalingPort = environment.PORT?.trim() || '8787';
  const isE2e = process.env.ROUND_E2E_MODE === 'true';
  const buildId = randomUUID();
  const release = JSON.stringify({ buildId });
  const base = viteBaseForAuthMode(environment.VITE_ROUND_AUTH_MODE);

  return {
    base,
    define: { 'import.meta.env.ROUND_WEB_BUILD_ID': JSON.stringify(buildId) },
    plugins: [
      react(),
      {
        name: 'round-release',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const requestPath = request.url?.split('?')[0];
            if (requestPath !== '/release.json' && requestPath !== `${base}release.json`)
              return next();
            response.setHeader('Content-Type', 'application/json');
            response.setHeader('Cache-Control', 'no-store');
            response.end(release);
          });
        },
        generateBundle() {
          this.emitFile({ type: 'asset', fileName: 'release.json', source: release });
          this.emitFile({
            type: 'asset',
            fileName: '.round-auth-mode',
            source: base === '/round-ui/' ? 'baton\n' : 'standalone\n',
          });
        },
      },
    ],
    envDir: repositoryRoot,
    resolve: {
      alias: {
        '@round/protocol': path.resolve(currentDirectory, '../../packages/protocol/src/index.ts'),
        '@round/rtc-core': path.resolve(currentDirectory, '../../packages/rtc-core/src/index.ts'),
      },
    },
    server: {
      host: '0.0.0.0',
      ...(isE2e ? { hmr: false } : {}),
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${signalingPort}`,
          changeOrigin: true,
          xfwd: true,
        },
        '/healthz': `http://127.0.0.1:${signalingPort}`,
        '/round/rooms': {
          target: `http://127.0.0.1:${signalingPort}`,
          changeOrigin: true,
          xfwd: true,
          ws: true,
          rewrite: rewriteBatonRoomEndpoint,
        },
        '/signal': {
          target: `http://127.0.0.1:${signalingPort}`,
          ws: true,
        },
      },
    },
  };
}

export function viteBaseForAuthMode(authMode: string | undefined): '/' | '/round-ui/' {
  const normalized = authMode?.trim() ?? '';
  if (normalized === '' || normalized === 'standalone') {
    return '/';
  }
  if (normalized === 'baton') {
    return '/round-ui/';
  }
  throw new Error('VITE_ROUND_AUTH_MODE must be standalone or baton');
}

export default defineConfig(createViteConfig);
