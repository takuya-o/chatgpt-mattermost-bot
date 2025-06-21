# NPM builder image
FROM node:24-bookworm-slim AS npm_builder
#22.12.0-bookworm-slim (Debian 12)
#22-bookworm-slim, 22-slim, 22.12-bookworm-slim, 22.12-slim, 22.12.0-bookworm-slim, 22.12.0-slim, jod-bookworm-slim, jod-slim, lts-bookworm-slim, lts-slim
# bookworm = Debian12

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
