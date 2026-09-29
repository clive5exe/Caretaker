# The image Warp's skills run in when the Caretaker agent step replaces Oz.
# Built by action.yml from THIS file, which ships with the action and is not
# in the workspace the agent can edit, so building it with network is safe.
FROM docker.io/library/node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Pinned, so a run says which CLI did the work. Bump deliberately.
ARG CLAUDE_CODE_VERSION=2.1.285
ARG CODEX_VERSION=0.159.1
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force
