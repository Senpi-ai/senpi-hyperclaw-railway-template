#!/bin/bash
set -euo pipefail

echo "[entrypoint] Starting OpenClaw Railway..."
echo "[entrypoint] OpenClaw version: $(openclaw --version 2>/dev/null || echo 'unknown')"

# Create data directories
mkdir -p /data /data/.openclaw /data/workspace /data/bin

# Secure permissions (best-effort for mounted volumes)
chmod 700 /data /data/.openclaw 2>/dev/null || true
chown -R openclaw:openclaw /data 2>/dev/null || true

exec gosu openclaw node src/server.js