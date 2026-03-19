# Build openclaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22-bookworm AS openclaw-build

# Dependencies needed for openclaw build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (openclaw build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable
WORKDIR /openclaw

# OpenClaw version control:
# - Set OPENCLAW_VERSION build-arg to pin a specific tag/branch (e.g., v2026.2.26)
# - If not set, falls back to v2026.2.22
ARG OPENCLAW_VERSION
RUN set -eux; \
  REF="${OPENCLAW_VERSION:-v2026.2.22}"; \
  echo "✓ Using OpenClaw ref: ${REF}"; \
  git clone --depth 1 --branch "${REF}" https://github.com/openclaw/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

RUN pnpm install --no-frozen-lockfile
RUN pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN pnpm ui:install && pnpm ui:build


# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    build-essential \
    gcc \
    g++ \
    make \
    procps \
    file \
    git \
    python3 \
    pkg-config \
    sudo \
    ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /app

# Wrapper deps
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

# Install MCPorter CLI so the mcporter skill can execute it (pinned for reproducible builds)
RUN npm install -g mcporter@0.7.3 mcp-remote@0.1.38

# Copy built openclaw
COPY --from=openclaw-build /openclaw /openclaw


# Vendor mcporter skill from the same OpenClaw ref used in build stage (no extra git clone)
RUN mkdir -p /opt/openclaw-skills
COPY --from=openclaw-build /openclaw/skills/mcporter /opt/openclaw-skills/mcporter

# Provide a openclaw executable
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

# rg wrapper: strip grep-style flags (-R, -r) that ripgrep doesn't accept
# (rg is recursive by default; agents sometimes pass grep-style flags)
RUN mv /usr/bin/rg /usr/bin/rg-real \
  && printf '%s\n' \
    '#!/usr/bin/env bash' \
    'args=()' \
    'for a in "$@"; do' \
    '  case "$a" in -R|-r) ;; *) args+=("$a") ;; esac' \
    'done' \
    'exec /usr/bin/rg-real "${args[@]}"' \
    > /usr/local/bin/rg \
  && chmod +x /usr/local/bin/rg

# Workspace bootstrap files (AGENTS.md, SOUL.md, BOOTSTRAP.md, TOOLS.md)
COPY workspace/AGENTS.md /opt/workspace-defaults/AGENTS.md
COPY workspace/SOUL.md /opt/workspace-defaults/SOUL.md
COPY workspace/BOOTSTRAP.md /opt/workspace-defaults/BOOTSTRAP.md
COPY workspace/TOOLS.md /opt/workspace-defaults/TOOLS.md

COPY src ./src

ENV PORT=8080
ENV MCPORTER_CONFIG="/data/.openclaw/config/mcporter.json"
EXPOSE 8080

CMD ["node", "src/server.js"]
