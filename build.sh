#!/bin/sh
npx esbuild --bundle --minify --sourcemap --platform=node --format=esm --packages=external --outfile=dist/botservice.mjs src/botservice.ts
cp -p ./node_modules/tiktoken-node/dist/tiktoken-node.linux-x64-gnu.node ./dist/
