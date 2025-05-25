# Use the official Node.js 18 image
FROM node:18

# Create app directory
WORKDIR /usr/src/app

# Copy app files
COPY package*.json ./
COPY index.js ./

# Install dependencies
RUN npm install

# Expose port (Cloud Run will assign it)
EXPOSE 8080

# Start app
CMD [ "npm", "start" ]
