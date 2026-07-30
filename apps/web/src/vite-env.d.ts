/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ROUND_AUTH_MODE?: 'standalone' | 'baton';
  readonly VITE_SIGNALING_URL?: string;
  readonly VITE_STUN_URLS?: string;
  readonly VITE_TURN_CREDENTIALS_URL?: string;
  readonly VITE_ICE_TRANSPORT_POLICY?: 'all' | 'relay';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
