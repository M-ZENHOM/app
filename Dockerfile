# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./
RUN npm ci

# Copy the rest of the application files
COPY . .
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./
RUN npm ci

# Copy built files from the builder stage
COPY --from=builder /app/dist ./dist

# Copy the rest of the application files
COPY . .

# Set environment variables for development
ENV NODE_ENV=production

# Expose the port the server runs on
EXPOSE 3006

# Install supervisor
RUN apk add --no-cache supervisor

# Copy supervisor configuration
COPY supervisord.conf /etc/supervisord.conf

# Set the entry point to run supervisor
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]
