FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8788

EXPOSE 8788
CMD ["npm", "start"]
