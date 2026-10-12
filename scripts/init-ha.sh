#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p secrets
chmod 700 secrets
command -v openssl >/dev/null 2>&1 || { echo 'Install openssl to generate HA secrets.' >&2; exit 1; }
if [ ! -f secrets/node_token ]; then openssl rand -hex 32 > secrets/node_token; fi
if [ ! -f secrets/ha_master_key ]; then openssl rand 32 > secrets/ha_master_key; fi
if [ ! -f secrets/ha_setup_token ]; then openssl rand -hex 32 > secrets/ha_setup_token; fi
# Parent directory remains private; Compose file-backed secrets are read by UID 1000.
chmod 444 secrets/node_token secrets/ha_master_key secrets/ha_setup_token
echo 'HA secrets ready in secrets/. Existing secrets were preserved.'
echo 'Start the isolated demonstration: docker compose -f compose.ha.yaml up -d --build'
