FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY db ./db
COPY docs/manual ./docs/manual
COPY scripts/build-operation-manual.py ./scripts/build-operation-manual.py
COPY Dockerfile ./Dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-reportlab fonts-ipafont-gothic poppler-utils && apt-get clean \
    && python3 scripts/build-operation-manual.py
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && apt-get clean
ENV NODE_ENV=production PORT=3000 BIND_HOST=0.0.0.0 NPL_REQUIRE_RELEASE_MANUAL=1
COPY --chown=node:node --from=build /app/package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/manual-generated ./manual-generated
COPY --chown=node:node db ./db
USER node
EXPOSE 3000
CMD ["node","dist/server.js"]
