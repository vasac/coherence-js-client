#!/usr/bin/env bash

# Copyright (c) 2020, 2026, Oracle and/or its affiliates.
# Licensed under the Universal Permissive License v 1.0 as shown at
# https://oss.oracle.com/licenses/upl.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "${ROOT}/bin/generate-grpc.js"
cp "${ROOT}/etc/jvm-args-clear.txt" "${ROOT}/etc/jvm-args.txt"
