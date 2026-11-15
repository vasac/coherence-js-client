/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test } = require('node:test')

const gate = path.resolve(__dirname, '../bin/dependency-security.js')
const temporaryRoot = process.platform === 'darwin' ? '/private/tmp/codex-work' : os.tmpdir()

// Only stubs are put on PATH. This test cannot reach a publication endpoint.
function exercise (failure, expected) {
  fs.mkdirSync(temporaryRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'coherence-security-test-'))
  try {
    const bin = path.join(directory, 'bin')
    const reports = path.join(directory, 'reports')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    fs.writeFileSync(path.join(directory, 'package-lock.json'), '{}')
    const stub = path.join(bin, 'stub')
    fs.writeFileSync(stub, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
const name = tool === 'npm' ? (args[0] === 'audit' ? (args.includes('--omit=dev') ? 'npm-production' : 'npm-full') : args[0]) : (args[0] === 'fs' ? 'trivy' : 'trivy-version')
fs.appendFileSync('calls.jsonl', JSON.stringify({ tool, args, name }) + '\\n')
if (args[0] === 'publish') { fs.writeFileSync('published', 'stub publication reached'); process.exit(0) }
if (name === '--version') { console.log('11.20.0'); process.exit(0) }
if (name === 'config') { console.log('https://registry.npmjs.org/'); process.exit(0) }
let report = tool === 'npm'
  ? { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } }
  : (name === 'trivy-version' ? { Version: '0.76.2', VulnerabilityDB: { Version: 2, UpdatedAt: '2026-11-15T00:00:00Z' } }
    : { SchemaVersion: 2, Results: [{ Type: 'npm', Target: 'package-lock.json', Packages: [{ Name: 'dev-tool', Dev: true }] }] })
const failure = process.env.GATE_TEST_FAILURE
if (failure === name + '-finding' || failure === name + '-silent-finding') {
  if (tool === 'npm') { report.metadata.vulnerabilities.total = 1; report.vulnerabilities = { package: { severity: 'info' } } }
  else report.Results[0].Vulnerabilities = [{ VulnerabilityID: 'TEST', Severity: 'UNKNOWN' }]
  console.log(JSON.stringify(report)); process.exit(failure.includes('silent') ? 0 : 1)
}
if (failure === name + '-error') { console.error('service unavailable'); process.exit(2) }
if (failure === name + '-malformed') { console.log('invalid JSON'); process.exit(0) }
if (failure === 'trivy-no-lockfile' && name === 'trivy') report.Results = []
if (failure === 'trivy-secret' && name === 'trivy') report.Results[0].Secrets = [{ RuleID: 'test-secret' }]
if (failure === 'changed-lockfile' && name === 'trivy') fs.appendFileSync('package-lock.json', ' ')
console.log(JSON.stringify(report))
`, { mode: 0o700 })
    for (const tool of ['npm', 'trivy']) fs.symlinkSync(stub, path.join(bin, tool))
    // Simulate the release job's default success condition between the gate and npm publish.
    const result = spawnSync('/bin/bash', ['-e', '-c', '"$GATE_TEST_NODE" "$GATE_TEST_SCRIPT" "$GATE_TEST_REPORTS"\nnpm publish'], {
      cwd: directory,
      env: { ...process.env, PATH: bin, NODE_ENV: 'production', GATE_TEST_NODE: process.execPath,
        GATE_TEST_SCRIPT: gate, GATE_TEST_REPORTS: reports, GATE_TEST_FAILURE: failure },
      encoding: 'utf8', timeout: 15000
    })
    assert.equal(result.status, expected, result.stdout + result.stderr)
    assert.equal(fs.existsSync(path.join(directory, 'published')), expected === 0, 'Gate failures must block publishing')
    const metadata = JSON.parse(fs.readFileSync(path.join(reports, 'metadata.json'), 'utf8'))
    assert.equal(metadata.passed, expected === 0)
    assert.equal(metadata.commands.length, 6, 'Collect all scans even after a failure')
    assert(metadata.startedAt && metadata.finishedAt && metadata.node)
    assert.match(metadata.inputSha256['package-lock.json'], /^[0-9a-f]{64}$/)
    for (const command of metadata.commands) assert(command.startedAt && command.finishedAt)
    for (const name of ['npm-production', 'npm-full', 'trivy', 'trivy-version']) {
      assert(fs.existsSync(path.join(reports, name + '.json')))
      assert(fs.existsSync(path.join(reports, name + '.stderr.txt')))
    }
    const calls = fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const production = calls.find(call => call.name === 'npm-production').args
    const full = calls.find(call => call.name === 'npm-full').args
    assert(production.includes('--omit=dev'))
    assert(full.includes('--include=dev'))
    for (const args of [production, full]) {
      assert(args.includes('--package-lock-only') && args.includes('--audit-level=info'))
      assert(!args.includes('fix'))
    }
    const trivy = calls.find(call => call.name === 'trivy').args
    assert(trivy.includes('--include-dev-deps') && trivy.includes('--exit-code=1'))
    assert(trivy.includes('--severity=UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL'))
    if (failure.endsWith('-error')) {
      const name = failure.slice(0, -6)
      assert.match(fs.readFileSync(path.join(reports, name + '.stderr.txt'), 'utf8'), /service unavailable/)
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('zero findings permits the stub publication', () => exercise('', 0))
for (const scanner of ['npm-production', 'npm-full', 'trivy']) {
  for (const failure of ['finding', 'silent-finding', 'error', 'malformed']) {
    test(`${scanner} ${failure} blocks publication and retains reports`, () => exercise(`${scanner}-${failure}`, 1))
  }
}
for (const failure of ['trivy-no-lockfile', 'trivy-secret', 'changed-lockfile', 'trivy-version-error']) {
  test(`${failure} blocks publication`, () => exercise(failure, 1))
}
