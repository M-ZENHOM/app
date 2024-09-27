# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Copy the rest of the application files
COPY . .

# Expose the port the server runs on
EXPOSE 3006

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["node", "dist/server.js"]