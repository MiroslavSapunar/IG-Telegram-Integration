# ---- build stage: compile native deps (better-sqlite3), then discard the toolchain ----
FROM node:20-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

# ---- runtime: slim base, no compiler — just node_modules + app ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package.json index.js ./
EXPOSE 3000
CMD ["node", "index.js"]
