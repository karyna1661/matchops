FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY tsconfig.json ./
EXPOSE 3001
CMD ["npx", "tsx", "src/demo/server.ts"]
