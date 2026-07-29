import { describe, expect, it } from 'vitest';
import { createViteConfig } from './vite.config';

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
});
