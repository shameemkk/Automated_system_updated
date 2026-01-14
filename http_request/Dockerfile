FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY *.ts ./
COPY *.js ./


CMD ["npm", "start"]