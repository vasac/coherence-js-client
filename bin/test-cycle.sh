#!/usr/bin/env bash

# Copyright (c) 2023, 2026, Oracle and/or its affiliates.
# Licensed under the Universal Permissive License v 1.0 as shown at
# https://oss.oracle.com/licenses/upl.

set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

if [ "$#" -ne 1 ] || { [ "$1" != -s ] && [ "$1" != -c ]; }; then
  echo "Usage: $0 [-s (TLS) | -c (plaintext)]" >&2
  exit 1
fi
mode=$1
export COHERENCE_VERSION=${COHERENCE_VERSION:-22.06.11}
export COHERENCE_TYPE=${COHERENCE_TYPE:-coherence-ce}
export DOCKER_REGISTRY=${DOCKER_REGISTRY:-ghcr.io/oracle}

# Every invocation owns its files and Compose project, including failed starts.
# /private/tmp is the macOS spelling; /tmp supports Linux development and CI.
temp_root=${TMPDIR:-/tmp}
if [ -d /private/tmp ]; then temp_root=/private/tmp; fi
mkdir -p "${temp_root}/codex-work"
work_dir=$(mktemp -d "${temp_root}/codex-work/coherence-js-cycle.XXXXXX")
project="coherence-js-$(basename "${work_dir}" | tr '[:upper:]' '[:lower:]' | tr '.' '-')"
export COHERENCE_TEST_ARGS_DIR="${work_dir}/args"
export COHERENCE_TEST_CERTS_DIR="${work_dir}/certs/server"
# Keep test-created fixtures under the outer trap, even if Mocha is killed at
# its overall deadline before its own after hooks can run.
export COHERENCE_TEST_TEMP_DIR="${work_dir}"
# Read owner-only private keys without opening permissions to other users.
COHERENCE_TEST_USER="$(id -u):$(id -g)"
export COHERENCE_TEST_USER
started=false
label=clear
active_pid=
# Separate process groups let cancellation stop npm/Node and their descendants.
# Waiting with Bash's builtin wait keeps INT/TERM traps responsive (Bash 3.2+).
set -m
stop_active() {
  local attempt
  if [ -n "${active_pid}" ]; then
    kill -TERM -- "-${active_pid}" 2>/dev/null || true
    for ((attempt=0; attempt<20; attempt++)); do
      if ! kill -0 -- "-${active_pid}" 2>/dev/null; then break; fi
      sleep 0.1
    done
    kill -KILL -- "-${active_pid}" 2>/dev/null || true
    wait "${active_pid}" 2>/dev/null || true
    active_pid=
  fi
}
run() {
  local status=0
  "$@" <&0 &
  active_pid=$!
  wait "${active_pid}" || status=$?
  # Also remove descendants left behind by a failed/timed-out command.
  stop_active
  return "${status}"
}
compose() {
  run docker compose --project-name "${project}" -f etc/docker-compose-2-members.yaml "$@"
}
cleanup() {
  result=$?
  trap - EXIT
  trap '' INT TERM
  stop_active
  if [ "${started}" = true ]; then
    if [ "${result}" -ne 0 ]; then
      compose logs --no-color > "logs-${label}-test-${COHERENCE_VERSION}-$(node -v).txt" 2>&1 || true
    fi
    compose down -v || result=1
  fi
  rm -rf -- "${work_dir}"
  exit "${result}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "${COHERENCE_TEST_ARGS_DIR}"

# Child-process exports never alter the caller's environment or etc/jvm-args.txt.
unset COHERENCE_TLS_CERTS_PATH COHERENCE_TLS_CLIENT_CERT COHERENCE_TLS_CLIENT_KEY
unset COHERENCE_IGNORE_INVALID_CERTS
export COHERENCE_SERVER_ADDRESS=localhost:1408
if [ "${mode}" = -s ]; then
  label=tls
  run bin/keys.sh "${work_dir}/certs"
  cp etc/jvm-args-tls.txt "${COHERENCE_TEST_ARGS_DIR}/jvm-args.txt"
  export COHERENCE_TLS_CERTS_PATH="${work_dir}/certs/ca.crt"
  export COHERENCE_TLS_CLIENT_CERT="${work_dir}/certs/client.crt"
  export COHERENCE_TLS_CLIENT_KEY="${work_dir}/certs/client.pem"
else
  mkdir -p "${COHERENCE_TEST_CERTS_DIR}"
  cp etc/jvm-args-clear.txt "${COHERENCE_TEST_ARGS_DIR}/jvm-args.txt"
fi

run npm run compile
started=true
compose --parallel 1 up -d
echo 'Waiting for Coherence readiness (up to 120 seconds) ...'
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  compose ps --all --status exited --quiet > "${work_dir}/exited"
  if [ -s "${work_dir}/exited" ]; then
    echo 'A Coherence test container exited during startup.' >&2
    exit 1
  fi
  run curl --max-time 1 -o /dev/null -s -w '%{http_code}' http://127.0.0.1:6676/ready > "${work_dir}/ready" || true
  if [ "$(< "${work_dir}/ready")" = 200 ]; then
    ready=true
    break
  fi
  run sleep 1
done
if [ "${ready}" != true ]; then
  echo 'Coherence did not become ready.' >&2
  exit 1
fi

# Node supplies the overall deadline on macOS and Linux, without GNU timeout.
run node <<'JS'
const { spawnSync } = require('node:child_process')
const result = spawnSync(process.execPath,
  [require.resolve('mocha/bin/mocha.js'), 'test/**.js', '--recursive', '--exit'],
  { stdio: 'inherit', timeout: 180000, killSignal: 'SIGKILL' })
if (result.error) console.error(result.error.message)
process.exit(result.status === null ? 1 : result.status)
JS
