# The editor is static files; the image is those files plus a node runtime for
# the small server that hands them out (server.js). No build step, no npm
# install — there are no dependencies to install.
FROM node:22-alpine

WORKDIR /app

COPY package.json server.js index.html ./
COPY css ./css
COPY js ./js

ENV PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080

# not root: the server only ever reads its own directory
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
