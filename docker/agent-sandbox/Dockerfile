FROM jetpackio/devbox:latest

# Install default packages (Node, Python, Bun, CLI tools) via Devbox.
# /nix is persisted via a named Docker volume — auto-populated from the
# image on first use, no manual snapshot/restore needed.
WORKDIR /opt/devbox-project
COPY --chown=devbox:devbox devbox.json /opt/devbox-project/devbox.json
RUN devbox install

# Install Claude Agent SDK using devbox's bun
WORKDIR /app
RUN sudo chown devbox:devbox /app
RUN devbox run -c /opt/devbox-project -- bun init -y && \
    devbox run -c /opt/devbox-project -- bun add @anthropic-ai/claude-agent-sdk@0.2.37

# Resolve the actual CLI path (bun's node_modules layout uses .cache/ indirection)
# and create a symlink at the well-known path the host process references.
RUN mkdir -p /app/claude-agent-sdk && \
    CLI_PATH=$(devbox run -c /opt/devbox-project -- node -e "console.log(require.resolve('@anthropic-ai/claude-agent-sdk/cli.js'))") && \
    ln -sf "$CLI_PATH" /app/claude-agent-sdk/cli.js

COPY --chown=devbox:devbox entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

WORKDIR /workspace
