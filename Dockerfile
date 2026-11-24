# Build the editor, then serve the built files with the small static server
# (server.js). The runtime image has no node_modules: the server has no
# dependencies and the page is already built.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY --from=build /src/dist ./dist

ENV PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080

# not root: the server only ever reads its own directory
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
