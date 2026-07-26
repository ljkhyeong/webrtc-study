import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const gradleExecutable = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const gradle = spawn(gradleExecutable, ['--no-daemon', ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

const forwardedSignals = ['SIGINT', 'SIGTERM'];
for (const signal of forwardedSignals) {
  process.once(signal, () => {
    gradle.kill(signal);
  });
}

gradle.once('error', (error) => {
  console.error('Unable to start the Gradle wrapper.', error);
  process.exitCode = 1;
});

gradle.once('exit', (code, signal) => {
  for (const forwardedSignal of forwardedSignals) {
    process.removeAllListeners(forwardedSignal);
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
