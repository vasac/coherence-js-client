/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

// Run from the checkout root. Keep all reports, but fail if any command or report fails.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')

assert(process.argv[2], 'Usage: node bin/dependency-security.js <report-directory>')
const directory = path.resolve(process.argv[2])
fs.mkdirSync(directory, { recursive: true })
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const inputs = ['package.json', 'package-lock.json']
const metadata = {
  startedAt: new Date().toISOString(),
  node: process.version,
  checkout: process.cwd(),
  inputSha256: Object.fromEntries(inputs.map(file => [file, sha256(file)])),
  commands: []
}
let failed = false
const save = () => fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
save()

function run (name, command, args, validate) {
  const entry = { name, command, args, startedAt: new Date().toISOString() }
  const output = path.join(directory, name + (validate ? '.json' : '.txt'))
  const errors = path.join(directory, name + '.stderr.txt')
  const stdout = fs.openSync(output, 'w')
  const stderr = fs.openSync(errors, 'w')
  let result
  try {
    result = spawnSync(command, args, { stdio: ['ignore', stdout, stderr], timeout: 10 * 60 * 1000 })
  } finally {
    fs.closeSync(stdout)
    fs.closeSync(stderr)
  }
  entry.finishedAt = new Date().toISOString()
  entry.exitCode = result.status
  entry.signal = result.signal
  try {
    if (result.error) throw result.error
    assert.equal(result.status, 0, `${command} exited ${result.status} (signal: ${result.signal})`)
    if (validate) validate(JSON.parse(fs.readFileSync(output, 'utf8')))
  } catch (error) {
    entry.error = error.message
    failed = true
    console.error(`${name}: FAILED: ${error.message}\n${fs.readFileSync(errors, 'utf8')}`)
  }
  metadata.commands.push(entry)
  save()
  console.log(`${name}: ${entry.error ? 'FAILED' : 'passed'}; report: ${output}`)
}

function validateAudit (report) {
  assert.equal(report.auditReportVersion, 2, 'Missing or unsupported npm audit report')
  assert(!report.error, 'npm returned an audit error')
  assert.equal(report.metadata.vulnerabilities.total, 0, 'npm reported dependency vulnerabilities')
  assert.equal(Object.keys(report.vulnerabilities).length, 0, 'npm reported dependency vulnerabilities')
}

run('npm-version', 'npm', ['--version'])
run('npm-registry', 'npm', ['config', 'get', 'registry'])
// Read the committed lockfile even if node_modules is absent or NODE_ENV=production.
const audit = ['audit', '--package-lock-only', '--json', '--audit-level=info', '--include=prod', '--include=optional', '--include=peer']
run('npm-production', 'npm', [...audit, '--omit=dev'], validateAudit)
run('npm-full', 'npm', [...audit, '--include=dev'], validateAudit)
run('trivy', 'trivy', [
  'fs', '--scanners=vuln,secret', '--include-dev-deps', '--exit-code=1',
  '--severity=UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL', '--ignore-unfixed=false',
  '--format=json', '--list-all-pkgs', '--no-progress', '.'
], report => {
  assert.equal(report.SchemaVersion, 2, 'Missing or unsupported Trivy report')
  assert(report.Results.some(result => result.Type === 'npm' && result.Target === 'package-lock.json' && result.Packages.length > 0),
    'Trivy did not report packages from the root npm lockfile')
  for (const result of report.Results) {
    assert.equal((result.Vulnerabilities || []).length, 0, 'Trivy reported dependency vulnerabilities')
    assert.equal((result.Secrets || []).length, 0, 'Trivy reported secrets')
  }
})
// Capture the database actually used, after Trivy has had a chance to update it.
run('trivy-version', 'trivy', ['--version', '--format=json'], report => {
  assert.equal(typeof report.Version, 'string', 'Missing Trivy version metadata')
})
for (const file of inputs) {
  if (sha256(file) !== metadata.inputSha256[file]) {
    failed = true
    metadata.inputError = `${file} changed during the scans`
  }
}
metadata.finishedAt = new Date().toISOString()
metadata.passed = !failed
save()
console.log(`Dependency security gate ${failed ? 'FAILED' : 'passed'}. Reports: ${directory}`)
process.exitCode = failed ? 1 : 0
