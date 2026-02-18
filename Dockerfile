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

# Pin to a known ref (tag/branch). If it doesn't exist, fall back to main.
ARG OPENCLAW_GIT_REF=main
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

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
# Install MCPorter CLI so the mcporter skill can execute it
RUN npm install -g mcporter mcp-remote

# Vendor mcporter skill from OpenClaw repo into image
RUN set -eux; \
  mkdir -p /opt/openclaw-skills; \
  git clone --depth 1 https://github.com/openclaw/openclaw.git /tmp/openclaw; \
  cp -r /tmp/openclaw/skills/mcporter /opt/openclaw-skills/; \
  rm -rf /tmp/openclaw

# Copy built openclaw
COPY --from=openclaw-build /openclaw /openclaw

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

# Workspace bootstrap files (AGENTS.md, SOUL.md, BOOT.md, TOOLS.md)
# Copied to the volume at runtime (only if not already present) by bootstrap.mjs
COPY workspace/AGENTS.md /opt/workspace-defaults/AGENTS.md
COPY workspace/SOUL.md /opt/workspace-defaults/SOUL.md
COPY workspace/BOOT.md /opt/workspace-defaults/BOOT.md
COPY workspace/TOOLS.md /opt/workspace-defaults/TOOLS.md

COPY src ./src

ENV PORT=8080
ENV MCPORTER_CONFIG="/data/.openclaw/config/mcporter.json"
EXPOSE 8080
CMD ["node", "src/server.js"]
#CMD ["bash", "-lc", "node src/bootstrap.js && node src/server.js"]
