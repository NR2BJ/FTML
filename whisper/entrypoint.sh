#!/bin/sh
# Whisper container entrypoint
# 1. Query FTML backend for the active model (set in web UI)
# 2. Fall back to WHISPER_MODEL env var
# 3. Fall back to first .bin file in /models/

set -e

BACKEND_URL="${BACKEND_URL:-http://backend:8080}"
API_URL="${BACKEND_URL}/internal/whisper/active-model"

echo "[entrypoint] Querying active model from backend: ${API_URL}"

# Try to get active model from backend API (retry up to 30 times with 2s interval = 60s)
ACTIVE_MODEL=""
for i in $(seq 1 30); do
  RESPONSE=$(wget -qO- "$API_URL" 2>/dev/null || true)
  if [ -n "$RESPONSE" ]; then
    # Parse JSON: {"model":"ggml-large-v3-turbo-q8_0.bin"}
    ACTIVE_MODEL=$(echo "$RESPONSE" | sed -n 's/.*"model"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    if [ -n "$ACTIVE_MODEL" ]; then
      echo "[entrypoint] Backend reports active model: ${ACTIVE_MODEL}"
      break
    fi
  fi
  echo "[entrypoint] Waiting for backend... (${i}/30)"
  sleep 2
done

# Determine which model to load (priority: API > env var > auto-detect)
MODEL=""

# 1. Try active model from API
if [ -n "$ACTIVE_MODEL" ] && [ -f "/models/${ACTIVE_MODEL}" ]; then
  MODEL="/models/${ACTIVE_MODEL}"
  echo "[entrypoint] Using active model from web UI: ${MODEL}"
fi

# 2. Fall back to WHISPER_MODEL env var
if [ -z "$MODEL" ] && [ -n "$WHISPER_MODEL" ] && [ -f "/models/${WHISPER_MODEL}" ]; then
  MODEL="/models/${WHISPER_MODEL}"
  echo "[entrypoint] Active model not found, using env var: ${MODEL}"
fi

# 3. Fall back to first available .bin
if [ -z "$MODEL" ]; then
  MODEL=$(ls /models/*.bin 2>/dev/null | head -1)
  if [ -n "$MODEL" ]; then
    echo "[entrypoint] Falling back to first available model: ${MODEL}"
  fi
fi

# No model found at all
if [ -z "$MODEL" ] || [ ! -f "$MODEL" ]; then
  echo "[entrypoint] ERROR: no model found in /models/"
  echo "[entrypoint] Available files:"
  ls -la /models/ 2>/dev/null || echo "  (directory empty or missing)"
  echo "[entrypoint] Please download a model via the FTML web UI (Settings > Whisper Models)"
  exit 1
fi

echo "[entrypoint] Loading model: ${MODEL}"
exec whisper-server --host 0.0.0.0 --port 8178 -m "$MODEL"
