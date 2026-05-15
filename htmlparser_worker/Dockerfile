FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (tsx is required at runtime)
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY worker.ts db.ts scraper.ts watchdog.ts worker-utils.ts ./


CMD ["npm", "start"]
