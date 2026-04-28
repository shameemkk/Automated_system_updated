FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/


CMD ["npm", "start"]