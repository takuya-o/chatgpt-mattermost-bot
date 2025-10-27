# NPM builder image
# FROM node:24-trixie-slim AS npm_builder
FROM node:24-bookworm-slim AS npm_builder
# node:24-trixie-slim 24.10.0-trixie-slim (Debian 13)
# node:24-bookworm-slim 24.10.0-bookworm-slim (Debian 12)
#22-bookworm-slim, 22-slim, 22.21-bookworm-slim, 22.21-slim, 22.21.0-bookworm-slim, 22.21.0-slim, jod-bookworm-slim, jod-slim, lts-bookworm-slim, lts-slim

WORKDIR /app
COPY [ "package.json", "package-lock.json", ".npmrc", \
  ".prettierignore", ".prettierrc", \
  "tsconfig.json", \
  "eslint.config.js", \
  "esbuild.config.js", \
  "./" ]
COPY [ "src/", "./src/" ]

RUN npm ci
RUN npm run lint
RUN npm run build
RUN rm -rf node_modules/ && npm ci --omit dev


# NPM runtime image
# See: https://github.com/GoogleContainerTools/distroless/tree/main/examples/nodejs
# For DEBUG: docker run -it --entrypoint=sh gcr.io/distroless/nodejs22-debian12:debug-nonroot
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS npm_runtime

WORKDIR /app

ARG NODE_ENV=production
ENV NODE_ENV $NODE_ENV
ENV PLUGINS=image-plugin,graph-plugin

COPY --chown=nonroot:nonroot --from=npm_builder [ "/app/node_modules/", "./node_modules/" ]
COPY --chown=nonroot:nonroot --from=npm_builder [ "/app/dist/", "./src/" ]
COPY [ "./license.md", "./" ]

# Avoid running as root:
USER nonroot

CMD [ "src/MultiInstance.mjs" ]
