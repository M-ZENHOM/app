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

# Install supervisor
RUN apk add --no-cache supervisor

# Copy supervisor configuration
COPY supervisord.conf /etc/supervisord.conf

# Set the entry point to run supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]