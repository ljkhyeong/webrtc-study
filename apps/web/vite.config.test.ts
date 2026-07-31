import { describe, expect, it } from 'vitest';
import { createViteConfig, rewriteBatonRoomEndpoint, viteBaseForAuthMode } from './vite.config';

describe('Vite development proxy', () => {
  it('forwards the browser origin metadata to the TURN credential endpoint', () => {
    const configuration = createViteConfig({
      command: 'serve',
      mode: 'test',
      isPreview: false,
      isSsrBuild: false,
    });

    expect(configuration.server?.proxy?.['/api']).toMatchObject({
      changeOrigin: true,
      xfwd: true,
    });
  });

  it('reproduces the BATON public-to-internal room endpoint mapping', () => {
    const configuration = createViteConfig({
      command: 'serve',
      mode: 'test',
      isPreview: false,
      isSsrBuild: false,
    });

    expect(configuration.server?.proxy?.['/round/rooms']).toMatchObject({
      changeOrigin: true,
      xfwd: true,
      ws: true,
    });
    expect(rewriteBatonRoomEndpoint('/round/rooms/abcd-efgh-jkmp/signal?attempt=2')).toBe(
      '/rooms/abcd-efgh-jkmp/signal?attempt=2',
    );
    expect(rewriteBatonRoomEndpoint('/round/rooms/abcd-efgh-jkmp/turn-credentials')).toBe(
      '/api/rooms/abcd-efgh-jkmp/turn-credentials',
    );
    expect(rewriteBatonRoomEndpoint('/round/rooms/abcd-efgh-jkmp/signal/extra')).toBe(
      '/round/rooms/abcd-efgh-jkmp/signal/extra',
    );
  });

  it('uses an isolated asset base for a BATON-owned runtime image', () => {
    expect(viteBaseForAuthMode(undefined)).toBe('/');
    expect(viteBaseForAuthMode('standalone')).toBe('/');
    expect(viteBaseForAuthMode('baton')).toBe('/round-ui/');
    expect(() => viteBaseForAuthMode('invalid')).toThrow();
  });
});
