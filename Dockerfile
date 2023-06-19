# NPM builder image
FROM node:20-slim as npm_builder
#20.3.0-bookworm-slim (Debian 12)

WORKDIR /app
COPY [ "package.json", "package-lock.json", ".npmrc", \
  ".eslintrc.json", ".prettierignore", ".prettierrc", \
  "tsconfig.json", \
  "esbuild.config.js", \
  "./" ]
COPY [ "src/", "./src/" ]

RUN npm ci
RUN npm run lint
RUN npm run build
RUN rm -rf node_modules/ && npm ci --omit dev


# NPM runtime image
FROM node:20-slim as npm_runtime

WORKDIR /app

ARG NODE_ENV=production
ENV NODE_ENV $NODE_ENV

# Avoid running as root:
USER node

COPY --from=npm_builder [ "/app/node_modules/", "./node_modules/" ]
COPY --from=npm_builder [ "/app/out/", "./out/" ]
COPY [ "./license.md", "./" ]

ENTRYPOINT [ "node", "out/botservice.mjs" ]
