#!/usr/bin/env bash

# Copyright (c) 2023, 2026, Oracle and/or its affiliates.
# Licensed under the Universal Permissive License v 1.0 as shown at
# https://oss.oracle.com/licenses/upl.

set -euo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <new-certificate-directory>" >&2
  exit 1
fi

CERTS_DIR=$1
# Refuse existing paths: never overwrite or delete somebody else's certificates.
mkdir -m 700 "${CERTS_DIR}"
complete=false
cleanup() {
  if [ "${complete}" != true ]; then rm -rf -- "${CERTS_DIR}"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -m 700 "${CERTS_DIR}/server"

cat > "${CERTS_DIR}/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
[client]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

openssl genrsa -out "${CERTS_DIR}/ca.key" 2048
openssl req -new -x509 -sha256 -days 30 -config "${CERTS_DIR}/openssl.cnf" \
  -extensions ca -key "${CERTS_DIR}/ca.key" -out "${CERTS_DIR}/ca.crt" \
  -subj '/CN=Coherence local test CA'

for role in server client; do
  if [ "${role}" = server ]; then
    identity="${CERTS_DIR}/server/server"
    serial=2
  else
    identity="${CERTS_DIR}/client"
    serial=3
  fi
  openssl genrsa -out "${identity}.key" 2048
  openssl req -new -sha256 -config "${CERTS_DIR}/openssl.cnf" \
    -key "${identity}.key" -out "${identity}.csr" -subj "/CN=Coherence test ${role}"
  openssl x509 -req -sha256 -days 30 -in "${identity}.csr" \
    -CA "${CERTS_DIR}/ca.crt" -CAkey "${CERTS_DIR}/ca.key" -set_serial "${serial}" \
    -extfile "${CERTS_DIR}/openssl.cnf" -extensions "${role}" -out "${identity}.crt"
  # Netty and grpc-js both accept unencrypted PKCS#8 PEM keys.
  openssl pkcs8 -topk8 -nocrypt -in "${identity}.key" -out "${identity}.pem"
  rm -- "${identity}.key" "${identity}.csr"
done

# Mount only this directory into the server, excluding the CA and client keys.
cp "${CERTS_DIR}/ca.crt" "${CERTS_DIR}/server/ca.crt"
rm -- "${CERTS_DIR}/openssl.cnf"
complete=true
