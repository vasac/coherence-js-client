/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { temporaryDirectory } = require('./helpers/tls-fixtures')

const root = path.resolve(__dirname, '..')
const tlsVariables = ['COHERENCE_TLS_CERTS_PATH', 'COHERENCE_TLS_CLIENT_CERT', 'COHERENCE_TLS_CLIENT_KEY']
const delay = millis => new Promise(resolve => setTimeout(resolve, millis))

async function waitUntil (condition, message) {
  const deadline = Date.now() + 8000
  while (!condition()) {
    assert(Date.now() < deadline, message)
    await delay(25)
  }
}

function killGroup (pid) {
  try { process.kill(-pid, 'SIGKILL') } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

describe('Test cycle isolation and cleanup', function () {
  this.timeout(15000)

  for (const [mode, failure, expected] of [
    ['-s', '', 0], ['-c', '', 0], ['-s', 'compile', 19], ['-s', 'up', 23], ['-s', 'suite', 29]
  ]) {
    it(`preserves caller configuration and cleans owned resources for ${mode} ${failure || 'success'}`, () => {
      const directory = temporaryDirectory('coherence-js-cycle-check-')
      const records = path.join(directory, 'calls.jsonl')
      const jvmArgs = path.join(root, 'etc/jvm-args.txt')
      const originalArgs = fs.existsSync(jvmArgs) ? fs.readFileSync(jvmArgs) : undefined
      const originalCerts = fs.existsSync(path.join(root, 'etc/cert'))
        ? fs.readdirSync(path.join(root, 'etc/cert')).sort() : undefined
      const version = `mock-${process.pid}-${path.basename(directory)}`
      const log = path.join(root, `logs-tls-test-${version}-v26.mock.txt`)
      try {
        fs.mkdirSync(path.join(directory, 'bin'))
        fs.writeFileSync(path.join(directory, 'sentinel'), 'caller-owned')
        const mock = path.join(directory, 'mock.js')
        fs.writeFileSync(mock, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
const env = process.env
if (tool === 'node' && args[0] === '-v') { console.log('v26.mock'); process.exit(0) }
fs.appendFileSync(env.CYCLE_RECORDS, JSON.stringify({ tool, args,
  argsDirectory: env.COHERENCE_TEST_ARGS_DIR, certsDirectory: env.COHERENCE_TEST_CERTS_DIR,
  testDirectory: env.COHERENCE_TEST_TEMP_DIR,
  user: env.COHERENCE_TEST_USER, address: env.COHERENCE_SERVER_ADDRESS,
  tls: [env.COHERENCE_TLS_CERTS_PATH, env.COHERENCE_TLS_CLIENT_CERT, env.COHERENCE_TLS_CLIENT_KEY],
  bypass: env.COHERENCE_IGNORE_INVALID_CERTS }) + '\\n')
if (tool === 'curl') process.stdout.write('200')
if (tool === 'npm' && env.CYCLE_FAILURE === 'compile') process.exit(19)
if (tool === 'docker' && args.includes('up') && env.CYCLE_FAILURE === 'up') process.exit(23)
if (tool === 'node') {
  // Simulate a test exiting without cleaning up its own generated fixture.
  fs.writeFileSync(path.join(env.COHERENCE_TEST_TEMP_DIR, 'abandoned-fixture'), 'test fixture')
  if (env.CYCLE_FAILURE === 'suite') process.exit(29)
}
`, { mode: 0o700 })
        for (const tool of ['npm', 'docker', 'curl', 'node']) fs.symlinkSync(mock, path.join(directory, 'bin', tool))
        const env = { ...process.env, PATH: path.join(directory, 'bin') + path.delimiter + process.env.PATH,
          CYCLE_RECORDS: records, CYCLE_FAILURE: failure, COHERENCE_VERSION: version,
          COHERENCE_IGNORE_INVALID_CERTS: 'true', COHERENCE_SERVER_ADDRESS: 'caller.example:9999',
          COHERENCE_TEST_ARGS_DIR: directory, COHERENCE_TEST_CERTS_DIR: directory,
          COHERENCE_TEST_USER: 'unrelated-user', COMPOSE_PROJECT_NAME: 'caller-project' }
        for (const variable of tlsVariables) env[variable] = path.join(directory, 'sentinel')
        const before = { ...env }
        const result = spawnSync('bash', ['bin/test-cycle.sh', mode], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
        assert.equal(result.status, expected, result.stderr)
        assert.deepEqual(env, before)
        const calls = fs.readFileSync(records, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const first = calls[0]
        assert.notEqual(first.argsDirectory, directory)
        assert.equal(fs.existsSync(path.dirname(first.argsDirectory)), false, 'Owned temporary directory must be removed')
        assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'caller-owned')
        assert.deepEqual(originalArgs, fs.existsSync(jvmArgs) ? fs.readFileSync(jvmArgs) : undefined)
        assert.deepEqual(originalCerts, fs.existsSync(path.join(root, 'etc/cert'))
          ? fs.readdirSync(path.join(root, 'etc/cert')).sort() : undefined)
        for (const call of calls) {
          assert.equal(call.testDirectory, path.dirname(first.argsDirectory))
          assert.equal(call.bypass, undefined, 'Inherited bypass must be removed')
          assert.equal(call.address, 'localhost:1408')
          assert.equal(call.user, `${process.getuid()}:${process.getgid()}`)
          if (mode === '-s') {
            assert.deepEqual(call.tls, ['ca.crt', 'client.crt', 'client.pem']
              .map(file => path.join(path.dirname(first.argsDirectory), 'certs', file)))
          } else assert.deepEqual(call.tls, [null, null, null])
        }
        const dockerCalls = calls.filter(call => call.tool === 'docker')
        if (failure === 'compile') assert.deepEqual(dockerCalls, [])
        else {
          assert(dockerCalls[0].args.includes('up'))
          assert(dockerCalls.at(-1).args.includes('down'))
          const project = dockerCalls[0].args[2]
          assert.match(project, /^coherence-js-/)
          assert.notEqual(project, 'caller-project')
          for (const call of dockerCalls) {
            assert.deepEqual(call.args.slice(0, 3), ['compose', '--project-name', project])
          }
        }
        assert.equal(calls.some(call => call.tool === 'node'), !['compile', 'up'].includes(failure))
      } finally {
        fs.rmSync(directory, { recursive: true, force: true })
        fs.rmSync(log, { force: true })
      }
    })
  }

  for (const [stage, signal, expected] of [
    ['compile', 'SIGTERM', 143], ['up', 'SIGTERM', 143],
    ['suite', 'SIGINT', 130], ['suite', 'SIGTERM', 143]
  ]) {
    it(`stops ${stage} and a TERM-resistant descendant on ${signal} to the cycle PID`, async function () {
      this.timeout(25000)
      const directory = temporaryDirectory('coherence-js-cycle-signal-')
      const records = path.join(directory, 'calls.jsonl')
      const heartbeat = path.join(directory, 'heartbeat')
      const version = `cancel-${process.pid}-${path.basename(directory)}`
      const log = path.join(root, `logs-tls-test-${version}-${process.version}.txt`)
      const calls = () => fs.existsSync(records)
        ? fs.readFileSync(records, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
      let cycle
      let result
      let unrelated
      let unrelatedClosed
      try {
        fs.mkdirSync(path.join(directory, 'bin'))
        fs.writeFileSync(path.join(directory, 'sentinel'), 'caller-owned')
        const descendant = path.join(directory, 'descendant.js')
        fs.writeFileSync(descendant, `
const fs = require('node:fs')
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
fs.appendFileSync(process.env.CYCLE_RECORDS, JSON.stringify({ descendant: process.pid }) + '\\n')
setInterval(() => fs.appendFileSync(process.env.CYCLE_HEARTBEAT, '.'), 25)
setTimeout(() => process.exit(73), 15000)
`)
        const mock = path.join(directory, 'mock.js')
        fs.writeFileSync(mock, `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const tool = path.basename(process.argv[1])
const args = process.argv.slice(2)
const env = process.env
if (tool === 'node' && args[0] === '-v') { console.log(process.version); process.exit(0) }
fs.appendFileSync(env.CYCLE_RECORDS, JSON.stringify({ tool, args, pid: process.pid,
  directory: env.COHERENCE_TEST_TEMP_DIR }) + '\\n')
const stage = tool === 'npm' ? 'compile' : tool === 'node' ? 'suite' :
  tool === 'docker' && args.includes('up') ? 'up' : ''
if (stage === env.CYCLE_STALL) {
  spawn(process.execPath, [env.CYCLE_DESCENDANT], { stdio: 'ignore' })
  setInterval(() => {}, 1000)
  setTimeout(() => process.exit(71), 15000)
} else if (tool === 'curl') process.stdout.write('200')
`, { mode: 0o700 })
        for (const tool of ['npm', 'docker', 'curl', 'node']) fs.symlinkSync(mock, path.join(directory, 'bin', tool))
        // This sibling must survive cancellation of the cycle's children.
        unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
          { stdio: 'ignore' })
        unrelatedClosed = new Promise(resolve => unrelated.once('close', resolve))
        cycle = spawn('/bin/bash', ['bin/test-cycle.sh', '-s'], { cwd: root, detached: true,
          env: { ...process.env, PATH: path.join(directory, 'bin') + path.delimiter + process.env.PATH,
            COHERENCE_VERSION: version, CYCLE_RECORDS: records, CYCLE_HEARTBEAT: heartbeat,
            CYCLE_STALL: stage, CYCLE_DESCENDANT: descendant } })
        let output = ''
        cycle.stdout.on('data', data => { output += data })
        cycle.stderr.on('data', data => { output += data })
        cycle.on('close', (code, signal) => { result = { code, signal } })
        await waitUntil(() => fs.existsSync(heartbeat), `Did not reach ${stage}: ${output}`)
        cycle.kill(signal)
        await waitUntil(() => result, `Cycle did not stop on ${signal}: ${output}`)
        assert.deepEqual(result, { code: expected, signal: null }, output)
        const stoppedHeartbeat = fs.readFileSync(heartbeat, 'utf8')
        await delay(150)
        assert.equal(fs.readFileSync(heartbeat, 'utf8'), stoppedHeartbeat, 'Descendant must stop before cleanup completes')
        assert.equal(fs.existsSync(calls().find(call => call.directory).directory), false)
        const dockerCalls = calls().filter(call => call.tool === 'docker')
        if (stage === 'compile') assert.deepEqual(dockerCalls, [])
        else {
          assert(dockerCalls.at(-1).args.includes('down'))
          const project = dockerCalls[0].args[2]
          assert.match(project, /^coherence-js-/)
          for (const call of dockerCalls) assert.equal(call.args[2], project)
        }
        assert.equal(fs.readFileSync(path.join(directory, 'sentinel'), 'utf8'), 'caller-owned')
        assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'Unrelated process must survive')
      } finally {
        for (const call of calls()) if (call.pid) killGroup(call.pid)
        if (cycle) {
          killGroup(cycle.pid)
          await waitUntil(() => result, 'Cycle failed to exit during test cleanup')
        }
        if (unrelated) {
          unrelated.kill('SIGKILL')
          await unrelatedClosed
        }
        for (const call of calls()) if (call.directory) fs.rmSync(call.directory, { recursive: true, force: true })
        fs.rmSync(directory, { recursive: true, force: true })
        fs.rmSync(log, { force: true })
      }
    })
  }
})
