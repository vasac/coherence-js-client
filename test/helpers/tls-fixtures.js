/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function temporaryDirectory (prefix) {
  const base = process.env.COHERENCE_TEST_TEMP_DIR ||
    path.join(fs.existsSync('/private/tmp') ? '/private/tmp' : os.tmpdir(), 'codex-work')
  fs.mkdirSync(base, { recursive: true })
  const directory = fs.mkdtempSync(path.join(base, prefix))
  fs.chmodSync(directory, 0o700)
  return directory
}

function tlsFixtures () {
  const directory = temporaryDirectory('coherence-js-tls-')
  const trusted = path.join(directory, 'trusted')
  const untrusted = path.join(directory, 'untrusted')
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true })
  try {
    for (const destination of [trusted, untrusted]) {
      execFileSync(path.resolve(__dirname, '../../bin/keys.sh'), [destination], { stdio: 'pipe' })
    }
    const config = path.join(directory, 'mismatch.cnf')
    fs.writeFileSync(config, `[req]
distinguished_name=dn
[dn]
[server]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:wrong.example.test
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
`)
    // Use the trusted CA and a valid server role, with a deliberately wrong SAN.
    // The matching CN must not override the mismatching SAN.
    const csr = path.join(directory, 'mismatch.csr')
    const mismatch = path.join(directory, 'mismatch.crt')
    const openssl = args => execFileSync('openssl', args, { stdio: 'pipe' })
    openssl(['req', '-new', '-sha256', '-config', config,
      '-key', path.join(trusted, 'server/server.pem'), '-out', csr, '-subj', '/CN=localhost'])
    openssl(['x509', '-req', '-sha256', '-days', '30', '-in', csr,
      '-CA', path.join(trusted, 'ca.crt'), '-CAkey', path.join(trusted, 'ca.key'),
      '-set_serial', '4', '-extfile', config, '-extensions', 'server', '-out', mismatch])
    return { directory, trusted, untrusted, mismatch, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

module.exports = { temporaryDirectory, tlsFixtures }
