FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tzdata
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
ENV PORT=8080 DATA_DIR=/data HA_INGRESS=1
CMD ["node", "--no-warnings", "src/server.js"]
