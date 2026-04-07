FROM node:20-alpine

WORKDIR /app

COPY package.json ./package.json
COPY src/server.js ./src/server.js

EXPOSE 3000

CMD ["node", "src/server.js"]
