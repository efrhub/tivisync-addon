FROM node:22-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
COPY server.js version.json ./
COPY public ./public
COPY run.sh /run.sh
RUN chmod +x /run.sh
CMD ["/run.sh"]
