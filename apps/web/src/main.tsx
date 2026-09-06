import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startBrowserMonitoring } from './lib/browser-monitoring';
import './styles.css';

void startBrowserMonitoring();

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('ROUND 앱을 마운트할 요소를 찾을 수 없습니다.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
