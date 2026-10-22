# Runner image for real agents. Build, then record its image id in the project attestation.
#   docker build -t aidept-runner -f docker/runner/Dockerfile docker/runner
FROM node:24-bookworm-slim
# Pin versions you have verified; the attestation records what you actually ran.
# The slim base ships no system CA bundle; the Codex CLI (native TLS) fails to reach its API without it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force
# Provider logins live in a named volume mounted at /auth. A new volume copies this directory's owner,
# so it must exist and belong to uid 1000 or `codex login` cannot write its token.
RUN mkdir /auth && chown 1000:1000 /auth
# The workspace is bind-mounted and owned by uid 1000, which is the image's built-in `node` user.
USER 1000:1000
WORKDIR /workspace
