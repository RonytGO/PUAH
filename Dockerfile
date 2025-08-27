# Use official Node 18
FROM node:18

# App dir
WORKDIR /usr/src/app

# Install deps first (better layer caching)
COPY package*.json ./
# Prefer CI when lockfile exists; fall back to install
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the app (this includes db.js!)
COPY . .

# Optional (Cloud Run ignores EXPOSE, but harmless)
EXPOSE 8080

# Production env
ENV NODE_ENV=production

# Start
CMD ["npm", "start"]
