import { pathToFileURL } from 'node:url';

import { readSignalingConfig } from './config.js';
import { createSignalingServer } from './server.js';

export async function main(): Promise<void> {
  const config = readSignalingConfig();
  const server = createSignalingServer(config);
  const address = await server.start();
  console.info(`ROUND signaling listening on ws://${address.host}:${address.port}/signal`);

  let shuttingDown = false;
  const shutDown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`Received ${signal}; shutting down signaling.`);
    try {
      await server.stop();
    } catch (error) {
      console.error('Failed to stop signaling cleanly.', error);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => {
    void shutDown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutDown('SIGTERM');
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error('Unable to start ROUND signaling.', error);
    process.exitCode = 1;
  });
}
