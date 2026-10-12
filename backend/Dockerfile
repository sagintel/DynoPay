# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=4000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# SQLite lives here when DATABASE_URL=sqlite:./data/...; mount a volume (or use Postgres/MySQL).
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
