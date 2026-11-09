#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -e deploy/compose/certs/tls.key || -e deploy/compose/certs/tls.crt ]]; then
  echo 'Certificate material already exists; refusing to overwrite.' >&2
  exit 1
fi
umask 077
mkdir -p deploy/compose/certs
openssl req -x509 -newkey rsa:3072 -nodes -days 7 \
  -config scripts/es-cert.conf \
  -keyout deploy/compose/certs/tls.key -out deploy/compose/certs/tls.crt
# Container UID 1000 reads files as group 0. Keep the key private on the host;
# use a named volume/Secret with appropriate ownership on Linux.
echo 'Certificates generated. For Compose, make certs readable by container UID 1000 before starting.'
