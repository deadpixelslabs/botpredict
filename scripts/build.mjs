import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('public', { recursive: true });
await copyFile('public/dashboard.html', 'public/index.html');
await mkdir('public/vendor', { recursive: true });
await copyFile('node_modules/chart.js/dist/chart.umd.js', 'public/vendor/chart.umd.js');
await build({ entryPoints: ['api/[...route].ts'], outfile: 'dist/api.cjs', bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', packages: 'external', sourcemap: false,
  logLevel: 'info' });
await import('./build-worker.mjs');
