// npx esbuild src/BotService.ts --bundle --outfile=out.js --platform=node --format=esm --packages=external

import { build } from 'esbuild';
import fs from 'fs';

await build({
  entryPoints: ['./src/MultiInstance.js'],
  bundle: true,
  minify: false,
  sourcemap: false,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: './dist/MultiInstance.mjs'
});

const wasmFile = fs.readFileSync(
  './node_modules/tiktoken-node/dist/tiktoken-node.linux-x64-gnu.node'
);

fs.writeFileSync('./dist/tiktoken-node.linux-x64-gnu.node', wasmFile);
