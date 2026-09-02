import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// vite-plugin-singlefile inlines JS/CSS into one index.html — src/web/server.ts
// reads that single file with readFileSync and serves it as-is, so publishing
// is just a copy.
const src = fileURLToPath(new URL('../dist/index.html', import.meta.url));
const dest = fileURLToPath(new URL('../../src/web/public/index.html', import.meta.url));

if (!existsSync(src)) {
  console.error(`Build output not found at ${src}`);
  process.exit(1);
}

copyFileSync(src, dest);
console.log(`Published web/dist/index.html -> ${dest}`);
