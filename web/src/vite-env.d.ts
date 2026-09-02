/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the demo API, when the frontend is deployed separately from src/web/server.ts. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
