# COSMIC Space Blink AI: one container = FastAPI backend + built React frontend.
# Build:  docker build -t cosmic-blink .
# Run:    docker run -p 8080:8080 -e SPHEREX_AI_KEY=... cosmic-blink   ->  http://localhost:8080
# Cloud Run sets $PORT itself; see "Deploy" in README.md.

# ---- 1. build the frontend -------------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. backend runtime ----------------------------------------------------
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    STATIC_DIR=/app/static \
    CACHE_DIR=/tmp/cosmic-cache \
    REDIS_URL=none
WORKDIR /app/backend

COPY backend/requirements.txt ./
RUN pip install -r requirements.txt

COPY backend/app ./app
COPY --from=web /web/dist /app/static

# run as an unprivileged user; the cache lives in /tmp (writable)
RUN useradd --create-home --uid 10001 cosmic
USER cosmic

EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
