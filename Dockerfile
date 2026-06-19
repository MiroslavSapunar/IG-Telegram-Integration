# better-sqlite3 is a native module — build toolchain present so it compiles if no prebuild matches.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production
COPY index.js ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
