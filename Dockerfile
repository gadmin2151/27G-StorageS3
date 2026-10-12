FROM node:22-alpine
WORKDIR /app
RUN mkdir -p /data && chown node:node /data /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
COPY --chown=node:node Dockerfile.disk-agent ./
COPY --chown=node:node scripts/install-agent.sh ./scripts/install-agent.sh
USER node
ENV HOST=0.0.0.0 DATA_DIR=/data PORT=9000
EXPOSE 9000
STOPSIGNAL SIGTERM
CMD ["node", "src/server.mjs"]
