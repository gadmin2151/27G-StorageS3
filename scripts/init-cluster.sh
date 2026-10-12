#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p secrets
chmod 700 secrets
if [ ! -f secrets/node_token ]; then
  command -v openssl >/dev/null 2>&1 || { echo 'Install openssl to generate the node secret.' >&2; exit 1; }
  openssl rand -hex 32 > secrets/node_token
  # Compose file-backed secrets retain host permissions; containers run as UID 1000.
  # Parent directory is private (0700); the mounted file must be readable in the container.
  chmod 444 secrets/node_token
fi
echo 'Cluster secret ready: secrets/node_token. Keep it private; enter it in the Cluster page.'
echo 'Start: docker compose --profile cluster up -d --build'
