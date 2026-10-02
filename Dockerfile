FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=7000 \
    CACHE_DIR=/cache \
    TORRENT_PORT=6881
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /cache && chown node:node /cache
USER node
VOLUME /cache
# 7000 = add-on + /play HTTP, 6881 = BitTorrent (optional, open it for more peers)
EXPOSE 7000 6881/tcp 6881/udp
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
