FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY worker.ts config.ts db.ts api-client.ts processor.ts batcher.ts watchdog.ts ./

CMD ["npm", "start"]
