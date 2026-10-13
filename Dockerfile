# Multi-stage production build for Qarz Daftar API
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY drizzle.config.ts ./
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle
COPY public ./public
COPY drizzle.config.ts ./

# Non-root user for security
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]
