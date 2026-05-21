FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=3000

CMD ["npm", "start"]
