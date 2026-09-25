FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src/ src/
RUN npm run build -- --rootDir .

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=build /build/dist/src/ dist/src/
COPY scripts/container-healthcheck.mjs scripts/container-healthcheck.mjs
RUN mkdir /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 7345
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "scripts/container-healthcheck.mjs", "/run/secrets/hotplate.json"]
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["aggregate", "--config", "/run/secrets/hotplate.json"]
