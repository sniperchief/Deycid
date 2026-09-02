import { cpSync, mkdirSync } from 'node:fs';

// The demo page is a static asset; tsc only emits JavaScript, so it has to be
// copied next to the compiled server for the readFileSync in server.ts to find.
mkdirSync('dist/web/public', { recursive: true });
cpSync('src/web/public', 'dist/web/public', { recursive: true });
console.log('copied src/web/public -> dist/web/public');
