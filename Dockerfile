# Multi-stage build for media-pipeline-mcp
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@8.15.4 --activate

WORKDIR /app

# Copy package files (including nested workspace packages)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/
COPY packages/storage/package.json packages/storage/tsconfig.json packages/storage/
COPY packages/security/package.json packages/security/tsconfig.json packages/security/
COPY packages/resilience/package.json packages/resilience/tsconfig.json packages/resilience/
COPY packages/observability/package.json packages/observability/tsconfig.json packages/observability/
COPY packages/providers/provider-core/package.json packages/providers/provider-core/tsconfig.json packages/providers/provider-core/
COPY packages/providers/stability/package.json packages/providers/stability/tsconfig.json packages/providers/stability/
COPY packages/providers/replicate/package.json packages/providers/replicate/tsconfig.json packages/providers/replicate/
COPY packages/providers/openai/package.json packages/providers/openai/tsconfig.json packages/providers/openai/
COPY packages/providers/elevenlabs/package.json packages/providers/elevenlabs/tsconfig.json packages/providers/elevenlabs/
COPY packages/providers/deepgram/package.json packages/providers/deepgram/tsconfig.json packages/providers/deepgram/
COPY packages/providers/google/package.json packages/providers/google/tsconfig.json packages/providers/google/
COPY packages/providers/anthropic/package.json packages/providers/anthropic/tsconfig.json packages/providers/anthropic/
COPY packages/providers/fal/package.json packages/providers/fal/tsconfig.json packages/providers/fal/

# Install dependencies
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY . .

# Build
RUN pnpm -r build

# Production stage
FROM node:20-alpine AS production

RUN apk add --no-cache ffmpeg curl

RUN corepack enable && corepack prepare pnpm@8.15.4 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/storage/package.json packages/storage/
COPY packages/security/package.json packages/security/
COPY packages/resilience/package.json packages/resilience/
COPY packages/observability/package.json packages/observability/
COPY packages/providers/provider-core/package.json packages/providers/provider-core/
COPY packages/providers/stability/package.json packages/providers/stability/
COPY packages/providers/replicate/package.json packages/providers/replicate/
COPY packages/providers/openai/package.json packages/providers/openai/
COPY packages/providers/elevenlabs/package.json packages/providers/elevenlabs/
COPY packages/providers/deepgram/package.json packages/providers/deepgram/
COPY packages/providers/google/package.json packages/providers/google/
COPY packages/providers/anthropic/package.json packages/providers/anthropic/
COPY packages/providers/fal/package.json packages/providers/fal/

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy all built files from builder
COPY --from=builder /app/packages/core/dist packages/core/dist
COPY --from=builder /app/packages/storage/dist packages/storage/dist
COPY --from=builder /app/packages/server/dist packages/server/dist
COPY --from=builder /app/packages/security/dist packages/security/dist
COPY --from=builder /app/packages/resilience/dist packages/resilience/dist
COPY --from=builder /app/packages/observability/dist packages/observability/dist
COPY --from=builder /app/packages/providers/provider-core/dist packages/providers/provider-core/dist
COPY --from=builder /app/packages/providers/stability/dist packages/providers/stability/dist
COPY --from=builder /app/packages/providers/replicate/dist packages/providers/replicate/dist
COPY --from=builder /app/packages/providers/openai/dist packages/providers/openai/dist
COPY --from=builder /app/packages/providers/elevenlabs/dist packages/providers/elevenlabs/dist
COPY --from=builder /app/packages/providers/deepgram/dist packages/providers/deepgram/dist
COPY --from=builder /app/packages/providers/google/dist packages/providers/google/dist
COPY --from=builder /app/packages/providers/anthropic/dist packages/providers/anthropic/dist
COPY --from=builder /app/packages/providers/fal/dist packages/providers/fal/dist

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create artifacts directory
RUN mkdir -p /app/artifacts && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "packages/server/dist/cli.js"]
