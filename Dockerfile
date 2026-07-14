# ============================================================
# The recipe for our app's shipping container.
# Each line is a step; Docker caches steps that haven't changed,
# so ordering matters: things that change rarely go first.
#
# (Deliberately single-stage for clarity. A "multi-stage" build
# that drops dev dependencies would roughly halve the image size —
# a later optimization, not a launch requirement.)
# ============================================================

FROM node:22-alpine
WORKDIR /app

# 1. Copy ONLY the dependency lists first — if code changes but
#    dependencies don't, Docker reuses the cached install (fast builds)
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

# 2. Now the actual source code
COPY . .

# 3. Build: generate the Prisma client, compile server TS → dist,
#    build the React app, and hand its files to Express to serve.
#    Prisma runs FROM the server folder — in a workspaces install its
#    binary may live in server/node_modules/.bin, not the root's.
RUN cd server && npx prisma generate && cd .. \
    && npm run build \
    && cp -r client/dist server/public

ENV NODE_ENV=production
EXPOSE 5000

# 4. On every start: apply any pending migrations, then run.
#    `migrate deploy` only applies committed migration files —
#    it never guesses or drifts. New version = new migrations applied.
CMD ["sh", "-c", "cd server && npx prisma migrate deploy && node dist/index.js"]
