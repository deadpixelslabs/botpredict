import { build } from 'esbuild';
await build({ entryPoints: ['worker/index.ts'], outfile: 'dist/worker.cjs', bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', packages: 'external', sourcemap: false,
  logLevel: 'info' });
