FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /srv

COPY server.js .

EXPOSE 9000

CMD ["node", "server.js"]
