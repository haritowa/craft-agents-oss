#!/bin/sh
set -e

# Activate base devbox environment (bun, node, python, git, etc.)
# This MUST succeed — without it, basic tools (bun, node, git) are missing.
eval "$(devbox shellenv --pure=false -c /opt/devbox-project)"

# Disable set -e for the optional user project activation below
set +e

# Initialize and activate the workspace's devbox project for agent-installed packages.
# This directory is bind-mounted from the host, so devbox.json persists
# across container restarts. --pure=false prepends to PATH so base
# packages stay available.
if [ -n "$DEVBOX_USER_PROJECT" ]; then
  # Auto-create and initialize the devbox project if it doesn't exist yet.
  # This ensures `devbox add -c $DEVBOX_USER_PROJECT` works on first use.
  if [ ! -f "$DEVBOX_USER_PROJECT/devbox.json" ]; then
    mkdir -p "$DEVBOX_USER_PROJECT"
    devbox init -c "$DEVBOX_USER_PROJECT" 2>/dev/null || true
  fi

  # Ensure packages are installed/resolved in this container.
  # devbox shellenv alone does NOT install packages — it only sets PATH entries
  # pointing to nix store paths. If the .devbox/ metadata is stale or missing
  # (common after container restart), shellenv outputs empty/wrong paths.
  # Running install first ensures all nix store refs are valid.
  # This is fast when packages are already in /nix (named volume).
  devbox install -c "$DEVBOX_USER_PROJECT" >/dev/null 2>/dev/null || true

  # Activate user-installed packages (noop if devbox.json has no packages yet)
  eval "$(devbox shellenv --pure=false -c "$DEVBOX_USER_PROJECT" 2>/dev/null)" || true
fi

exec "$@"
