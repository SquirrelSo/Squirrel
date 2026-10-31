FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
COPY migrations/ ./migrations/
COPY alembic.ini ./
ENV PORT=8100
EXPOSE 8100
# Migrate, then serve. One worker: the rate limiter is in-process (see app/ratelimit.py).
CMD alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*' --workers 1
