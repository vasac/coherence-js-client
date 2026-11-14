/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const tls = require('node:tls')
const { X509Certificate } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const grpc = require('@grpc/grpc-js')
const { Int32Value } = require('google-protobuf/google/protobuf/wrappers_pb')
const { Session } = require('../lib')
const { NamedCacheServiceService, NamedCacheServiceClient } = require('../lib/grpc/services_grpc_pb')
const { SizeRequest, MapListenerResponse, MapListenerSubscribedResponse } = require('../lib/grpc/messages_pb')
const { tlsFixtures } = require('./helpers/tls-fixtures')

// These peers speak real HTTP/2 gRPC and require a trusted client certificate.
// No channel hostname overrides, resolver substitutions, or global TLS changes.
async function peer (fixtures, identity, certificate) {
  const server = new grpc.Server()
  let calls = 0
  server.addService(NamedCacheServiceService, {
    size (_, callback) {
      calls++
      callback(null, new Int32Value().setValue(42))
    },
    events (stream) {
      stream.on('data', request => stream.write(new MapListenerResponse().setSubscribed(
        new MapListenerSubscribedResponse().setUid(request.getUid()))))
      stream.on('end', () => stream.end())
      stream.on('error', () => {})
    }
  })
  try {
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0',
      grpc.ServerCredentials.createSsl(fs.readFileSync(path.join(fixtures.trusted, 'ca.crt')), [{
        private_key: fs.readFileSync(path.join(identity, 'server/server.pem')),
        cert_chain: fs.readFileSync(certificate || path.join(identity, 'server/server.crt'))
      }], true), (error, port) => error ? reject(error) : resolve(port)))
    return { port, close: () => server.forceShutdown(), get calls () { return calls } }
  } catch (error) {
    server.forceShutdown()
    throw error
  }
}

function sessionFor (fixtures, endpoint, value, host = 'localhost') {
  const previous = process.env.COHERENCE_IGNORE_INVALID_CERTS
  const warn = console.warn
  const warnings = []
  try {
    if (value === undefined) delete process.env.COHERENCE_IGNORE_INVALID_CERTS
    else process.env.COHERENCE_IGNORE_INVALID_CERTS = value
    console.warn = warning => warnings.push(warning)
    const session = new Session({ address: `${host}:${endpoint.port}`,
      readyTimeoutInMillis: 3000, requestTimeoutInMillis: 3000,
      channelOptions: { 'grpc.use_local_subchannel_pool': 1, 'grpc.enable_retries': 0 },
      tls: { enabled: true, caCertPath: path.join(fixtures.trusted, 'ca.crt'),
        clientCertPath: path.join(fixtures.trusted, 'client.crt'),
        clientKeyPath: path.join(fixtures.trusted, 'client.pem') } })
    return { session, warnings }
  } finally {
    console.warn = warn
    if (previous === undefined) delete process.env.COHERENCE_IGNORE_INVALID_CERTS
    else process.env.COHERENCE_IGNORE_INVALID_CERTS = previous
  }
}

// Use Session's actual channel with the generated client so fail-fast RPC errors
// retain the TLS cause; a generic waitForReady deadline is not rejection evidence.
async function rejectedCall (fixtures, endpoint, value, pattern) {
  const { session, warnings } = sessionFor(fixtures, endpoint, value)
  const client = new NamedCacheServiceClient(session.address, session.channelCredentials,
    { channelOverride: session.channel })
  const before = endpoint.calls
  try {
    await assert.rejects(new Promise((resolve, reject) => client.size(
      new SizeRequest().setCache('tls-rejection'), { deadline: Date.now() + 3000 },
      (error, response) => error ? reject(error) : resolve(response))), error => {
      assert.equal(error.code, grpc.status.UNAVAILABLE, error.stack)
      assert.match(error.details, pattern)
      assert.doesNotMatch(error.details, /ECONNREFUSED|deadline exceeded|timed out/i)
      return true
    })
    assert.equal(endpoint.calls, before, 'Rejected TLS must not invoke the service')
    return warnings
  } finally {
    client.close()
    await session.close()
  }
}

const identityError = /hostname\/ip does not match certificate|not in the cert's altnames/i
const chainError = /self.signed certificate|unable to verify.*certificate|unable to get.*issuer certificate|certificate signature failure/i

describe('TLS certificate and hostname verification through Session and grpc-js', function () {
  this.timeout(15000)
  let fixtures
  let matching
  let mismatching
  let untrusted
  before(async () => {
    fixtures = tlsFixtures()
    matching = await peer(fixtures, fixtures.trusted)
    mismatching = await peer(fixtures, fixtures.trusted, fixtures.mismatch)
    untrusted = await peer(fixtures, fixtures.untrusted)
  })
  after(() => {
    matching?.close()
    mismatching?.close()
    untrusted?.close()
    fixtures?.cleanup()
  })

  it('generates separate signed identities with server SANs, roles, PKCS#8 keys and private permissions', () => {
    const read = file => fs.readFileSync(path.join(fixtures.trusted, file))
    const ca = new X509Certificate(read('ca.crt'))
    const server = new X509Certificate(read('server/server.crt'))
    const client = new X509Certificate(read('client.crt'))
    assert.equal(ca.ca, true)
    assert.equal(server.ca, false)
    assert.equal(client.ca, false)
    assert(server.verify(ca.publicKey))
    assert(client.verify(ca.publicKey))
    assert.equal(server.subjectAltName, 'DNS:localhost, IP Address:127.0.0.1')
    assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1'])
    assert.deepEqual(client.keyUsage, ['1.3.6.1.5.5.7.3.2'])
    assert.notEqual(server.publicKey.export({ type: 'spki', format: 'pem' }),
      client.publicKey.export({ type: 'spki', format: 'pem' }))
    for (const key of ['client.pem', 'server/server.pem']) assert.match(read(key).toString(), /^-----BEGIN PRIVATE KEY-----/)
    for (const key of ['ca.key', 'client.pem', 'server/server.pem']) {
      assert.equal(fs.statSync(path.join(fixtures.trusted, key)).mode & 0o077, 0)
    }
    assert.deepEqual(fs.readdirSync(path.join(fixtures.trusted, 'server')).sort(), ['ca.crt', 'server.crt', 'server.pem'])
    execFileSync('openssl', ['verify', '-CAfile', path.join(fixtures.trusted, 'ca.crt'),
      '-purpose', 'sslserver', path.join(fixtures.trusted, 'server/server.crt')])
    execFileSync('openssl', ['verify', '-CAfile', path.join(fixtures.trusted, 'ca.crt'),
      '-purpose', 'sslclient', path.join(fixtures.trusted, 'client.crt')])
  })

  it('refuses to overwrite an existing certificate directory', () => {
    const before = fs.readFileSync(path.join(fixtures.trusted, 'ca.crt'))
    assert.throws(() => execFileSync(path.resolve(__dirname, '../bin/keys.sh'), [fixtures.trusted], { stdio: 'pipe' }))
    assert.deepEqual(fs.readFileSync(path.join(fixtures.trusted, 'ca.crt')), before)
  })

  // grpc-js 1.14.7 sends IP literals as SNI, rejected by Node 26 (DEP0123).
  const grpcHosts = Number(process.versions.node.split('.')[0]) < 26 ? ['localhost', '127.0.0.1'] : ['localhost']
  for (const host of grpcHosts) {
    it(`accepts a trusted matching server at ${host} with verification enabled`, async () => {
      const { session, warnings } = sessionFor(fixtures, matching, undefined, host)
      try {
        const client = new NamedCacheServiceClient(session.address, session.channelCredentials,
          { channelOverride: session.channel })
        const response = await new Promise((resolve, reject) => client.size(new SizeRequest(),
          { deadline: Date.now() + 3000 }, (error, response) => error ? reject(error) : resolve(response)))
        assert.equal(response.getValue(), 42)
        assert.equal(await session.getCache('tls-positive').size, 42)
        assert.deepEqual(warnings, [])
      } finally { await session.close() }
    })
  }

  it('verifies the IP SAN through Node TLS without sending an IP literal as SNI', async () => {
    const socket = tls.connect({ host: '127.0.0.1', port: matching.port,
      ca: fs.readFileSync(path.join(fixtures.trusted, 'ca.crt')),
      cert: fs.readFileSync(path.join(fixtures.trusted, 'client.crt')),
      key: fs.readFileSync(path.join(fixtures.trusted, 'client.pem')),
      ALPNProtocols: ['h2'], rejectUnauthorized: true })
    try {
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve)
        socket.once('error', reject)
        socket.setTimeout(3000, () => reject(new Error('TLS positive control timed out')))
      })
      assert.equal(socket.authorized, true)
    } finally { socket.destroy() }
  })

  for (const value of [undefined, '', 'false', '0', '1', 'FALSE', 'TRUE', ' true', 'true ', 'yes', 'arbitrary']) {
    it(`rejects a trusted wrong hostname with opt-out ${JSON.stringify(value)}`, async () => {
      assert.deepEqual(await rejectedCall(fixtures, mismatching, value, identityError), [])
    })
  }

  it('rejects an untrusted matching server with verification enabled', async () => {
    assert.deepEqual(await rejectedCall(fixtures, untrusted, undefined, chainError), [])
  })

  it('allows a trusted wrong hostname only for exact true and warns accurately', async () => {
    const { session, warnings } = sessionFor(fixtures, mismatching, 'true')
    try {
      assert.equal(await session.getCache('tls-opt-out').size, 42)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /disables TLS server hostname verification/)
      assert.match(warnings[0], /Certificate-chain validation remains enabled/)
    } finally { await session.close() }
    // The opt-out must not affect a later session in the same process.
    assert.deepEqual(await rejectedCall(fixtures, mismatching, 'false', identityError), [])
  })

  it('still rejects an untrusted chain with the explicit hostname opt-out', async () => {
    const warnings = await rejectedCall(fixtures, untrusted, 'true', chainError)
    assert.equal(warnings.length, 1)
  })
})
