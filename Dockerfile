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

# The port the app actually listens on. EXPOSE is documentation only — the
# host decides the real mapping — but a number that disagrees with reality is
# worse than none, because the next person believes it. This said 5000 while
# the server bound 8080.
EXPOSE 8080

# 4. Drop root.
#
# Everything above needs write access to /app; nothing below does. A process
# that keeps root for no reason hands a container escape or a compromised
# dependency far more than it needs — root inside the container is root on the
# mounted filesystem, and can install packages, rewrite the app, or read
# anything the container can reach.
#
# `node:22-alpine` ships an unprivileged `node` user (uid 1000). The chown is
# required: the build ran as root, so /app is root-owned, and the Prisma
# engine binaries must stay readable and executable by whoever runs them.
RUN chown -R node:node /app
USER node

# 5. On every start: apply any pending migrations, then run.
#    `migrate deploy` only applies committed migration files —
#    it never guesses or drifts. New version = new migrations applied.
#
# NOTE: `prisma` is a devDependency and is deliberately still installed in
# this image. Pruning dev dependencies (a multi-stage build) would remove the
# CLI this line depends on, and the failure would appear at RUNTIME, not build
# time — a green build followed by a crash-looping container. If that
# optimization is ever done, move `prisma` into dependencies first.
CMD ["sh", "-c", "cd server && npx prisma migrate deploy && node dist/index.js"]
