/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const grpc = require('@grpc/grpc-js')
const { Int32Value } = require('google-protobuf/google/protobuf/wrappers_pb')
const { CoherenceResolver, Session, event } = require('../lib')
const { NamedCacheServiceService } = require('../lib/grpc/services_grpc_pb')
const { MapListenerResponse, MapListenerSubscribedResponse } = require('../lib/grpc/messages_pb')
const { nameService } = require('./helpers/name-service')

const backoff = { 'grpc.initial_reconnect_backoff_ms': 30, 'grpc.max_reconnect_backoff_ms': 60 }
const localQuery = 'NameService/string/$GRPC:GrpcProxy'

async function until (predicate) {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await delay(10)
  assert.ok(predicate(), 'Condition did not become true before the deadline')
}

function resolveOnce (path) {
  return new Promise(resolve => {
    const resolver = new CoherenceResolver({ scheme: 'coherence', path }, (...args) => {
      resolver.destroy()
      resolve(args)
      return true
    }, backoff)
    resolver.updateResolution()
  })
}

async function proxy (id) {
  const server = new grpc.Server()
  let calls = 0
  server.addService(NamedCacheServiceService, {
    size (_, callback) {
      calls++
      callback(null, new Int32Value().setValue(id))
    },
    events (stream) {
      stream.on('data', request => stream.write(new MapListenerResponse().setSubscribed(
        new MapListenerSubscribedResponse().setUid(request.getUid()))))
      stream.on('end', () => stream.end())
      stream.on('error', () => {})
    }
  })
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0',
    grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)))
  return { port, close: () => server.forceShutdown(), get calls () { return calls } }
}

describe('Coherence resolver callback and socket regressions', function () {
  this.timeout(5000)

  it('preserves default, explicit and foreign NameService ports and authority', () => {
    for (const [path, expected] of [
      ['host', ['host', '7574', '']], ['host:12345', ['host', '12345', '']],
      ['host/remote', ['host', '7574', 'remote']], ['host:12345/remote', ['host', '12345', 'remote']]
    ]) {
      assert.deepEqual(CoherenceResolver.parseConn(path), expected)
      assert.equal(CoherenceResolver.getDefaultAuthority({ path }), 'host')
    }
  })

  it('reports endpoints asynchronously through the exported StatusOr contract', async () => {
    const ns = await nameService(() => '[127.0.0.1, 1408, ::1, 1409]')
    let synchronous = true
    let resolver
    try {
      const args = await new Promise(resolve => {
        resolver = new CoherenceResolver({ path: `127.0.0.1:${ns.port}` }, (...args) => {
          assert.equal(synchronous, false)
          resolve(args)
          return true
        }, backoff)
        resolver.updateResolution()
        synchronous = false
      })
      assert.deepEqual(args, [grpc.experimental.statusOrFromValue([
        { addresses: [{ host: '127.0.0.1', port: 1408 }] },
        { addresses: [{ host: '::1', port: 1409 }] }
      ]), {}, null, ''])
      assert.deepEqual(ns.queries, [localQuery])
      await until(() => ns.sockets.size === 0)
    } finally {
      resolver?.destroy()
      await ns.close()
    }
  })

  it('performs foreign lookup and resolves the returned NameService port', async () => {
    const foreign = await nameService(() => '[127.0.0.1, 1409]')
    const local = await nameService(() => String(foreign.port))
    try {
      const [result] = await resolveOnce(`127.0.0.1:${local.port}/remote`)
      assert.deepEqual(result, grpc.experimental.statusOrFromValue([
        { addresses: [{ host: '127.0.0.1', port: 1409 }] }
      ]))
      assert.deepEqual(local.queries, ['NameService/string/Cluster/foreign/remote/NameService/localPort'])
      assert.deepEqual(foreign.queries, [localQuery])
    } finally {
      await local.close()
      await foreign.close()
    }
  })

  it('handles fragmented frames and multi-byte string lengths', async () => {
    // Exceeds two packed-length bytes; the former decoder could loop forever.
    const ns = await nameService(() => `[${Array(700).fill('127.0.0.1, 1408').join(', ')}]`, { fragment: true })
    try {
      const [result] = await resolveOnce(`127.0.0.1:${ns.port}`)
      assert.equal(result.ok, true)
      assert.equal(result.value.length, 700)
      for (const endpoint of result.value) {
        assert.deepEqual(endpoint, { addresses: [{ host: '127.0.0.1', port: 1408 }] })
      }
    } finally { await ns.close() }
  })

  it('coalesces concurrent requests, repeats resolution, and retries rejected results with backoff', async () => {
    const ns = await nameService(() => '[127.0.0.1, 1408]')
    const results = []
    const resolver = new CoherenceResolver({ path: `127.0.0.1:${ns.port}` }, result => {
      results.push(result)
      return results.length !== 1
    }, backoff)
    try {
      resolver.updateResolution()
      resolver.updateResolution()
      await until(() => results.length === 2)
      assert.ok(results.every(result => result.ok))
      assert.equal(ns.connections, 2)
      await delay(100)
      assert.equal(results.length, 2, 'Accepted results should stop retrying')
      resolver.updateResolution()
      await until(() => results.length === 3)
      assert.equal(ns.connections, 3)
    } finally {
      resolver.destroy()
      await ns.close()
    }
  })

  for (const reply of ['[]', 'garbage', '[127.0.0.1]', '[, 1234]', '[127.0.0.1, 0]',
    '[127.0.0.1, 65536]', '[127.0.0.1, 12oops]']) {
    it(`reports an UNAVAILABLE StatusOr for malformed endpoints ${reply}`, async () => {
      const ns = await nameService(() => reply)
      try {
        const [result, attributes, config, note] = await resolveOnce(`127.0.0.1:${ns.port}`)
        assert.equal(result.ok, false)
        assert.equal(result.error.code, grpc.status.UNAVAILABLE)
        assert.equal(typeof result.error.details, 'string')
        assert.ok(result.error.metadata instanceof grpc.Metadata)
        assert.deepEqual([attributes, config, note], [{}, null, ''])
      } finally { await ns.close() }
    })
  }

  it('reports foreign lookup rejection and invalid returned ports', async () => {
    for (const reply of ['', 'not-a-port', '0', '65536']) {
      const ns = await nameService(() => reply)
      try {
        const [result] = await resolveOnce(`127.0.0.1:${ns.port}/missing`)
        assert.equal(result.ok, false)
        assert.equal(result.error.code, grpc.status.UNAVAILABLE)
        assert.equal(ns.connections, 1)
      } finally { await ns.close() }
    }
  })

  it('reports connection refusal from local and foreign lookups without unhandled rejection', async () => {
    const ns = await nameService(() => '')
    const port = ns.port
    await ns.close()
    for (const path of [`127.0.0.1:${port}`, `127.0.0.1:${port}/missing`]) {
      const [result] = await resolveOnce(path)
      assert.equal(result.ok, false)
      assert.equal(result.error.code, grpc.status.UNAVAILABLE)
      assert.match(result.error.details, /ECONNREFUSED/)
    }
    const local = await nameService(() => String(port))
    try {
      const [result] = await resolveOnce(`127.0.0.1:${local.port}/remote`)
      assert.equal(result.ok, false)
      assert.match(result.error.details, /ECONNREFUSED/)
    } finally { await local.close() }
  })

  for (const [name, phase, bytes] of [
    ['empty channel', 1, [1, 0]], ['negative frame length', 2, [64]],
    ['oversized packed integer', 2, [128, 128, 128, 128, 128, 128]],
    ['truncated string', 2, [10, 0, 0, 0, 0, 0, 0, 0, 0, 63, 64]]
  ]) {
    it(`reports malformed protocol replies: ${name}`, async () => {
      const ns = await nameService(() => '[127.0.0.1, 1408]', {
        response: (current, frame) => current === phase ? Buffer.from(bytes) : frame
      })
      try {
        const [result] = await resolveOnce(`127.0.0.1:${ns.port}`)
        assert.equal(result.ok, false)
        assert.equal(result.error.code, grpc.status.UNAVAILABLE)
      } finally { await ns.close() }
    })
  }

  it('settles a lookup if the peer closes before its response is complete', async () => {
    const ns = await nameService((_, socket) => { socket.end(Buffer.from([20, 1])); return null })
    try {
      const [result] = await resolveOnce(`127.0.0.1:${ns.port}`)
      assert.equal(result.ok, false)
      assert.match(result.error.details, /closed before lookup completed/)
    } finally { await ns.close() }
  })

  it('times out and cleans up a stalled lookup', async function () {
    this.timeout(12000)
    const ns = await nameService(() => null)
    try {
      const [result] = await resolveOnce(`127.0.0.1:${ns.port}`)
      assert.equal(result.ok, false)
      assert.match(result.error.details, /timed out/)
      await until(() => ns.sockets.size === 0)
    } finally { await ns.close() }
  })

  it('cancels in-flight lookups, suppresses stale callbacks, and can restart after destroy', async () => {
    let reply = null
    const ns = await nameService(() => reply)
    const results = []
    const resolver = new CoherenceResolver({ path: `127.0.0.1:${ns.port}` }, result => {
      results.push(result)
      return false
    }, backoff)
    try {
      resolver.updateResolution()
      await until(() => ns.queries.length === 1)
      resolver.destroy()
      await until(() => ns.sockets.size === 0)
      await delay(100)
      assert.deepEqual(results, [])
      reply = '[127.0.0.1, 1408]'
      resolver.updateResolution()
      await until(() => results.length === 1)
      resolver.destroy() // Also cancels a scheduled rejection retry.
      await delay(100)
      assert.equal(results.length, 1)
      assert.equal(ns.connections, 2)
    } finally {
      resolver.destroy()
      await ns.close()
    }
  })

  it('suppresses a queued lookup destroyed before it starts, including across immediate restart', async () => {
    const ns = await nameService(() => '[127.0.0.1, 1408]')
    const results = []
    const resolver = new CoherenceResolver({ path: `127.0.0.1:${ns.port}` }, result => {
      results.push(result)
      return true
    }, backoff)
    try {
      resolver.updateResolution()
      resolver.destroy()
      resolver.updateResolution()
      await until(() => results.length === 1)
      assert.equal(results[0].ok, true)
      assert.equal(ns.connections, 1)
    } finally {
      resolver.destroy()
      await ns.close()
    }
  })

  it('does not start the second lookup after cancellation of foreign discovery', async () => {
    const foreign = await nameService(() => '[127.0.0.1, 1408]')
    let releaseReply
    const reply = new Promise(resolve => { releaseReply = resolve })
    const local = await nameService(() => reply)
    const results = []
    const resolver = new CoherenceResolver({ path: `127.0.0.1:${local.port}/remote` }, result => {
      results.push(result)
      return false
    }, backoff)
    try {
      resolver.updateResolution()
      await until(() => local.queries.length === 1)
      resolver.destroy()
      releaseReply(String(foreign.port))
      await until(() => local.sockets.size === 0)
      await delay(100)
      assert.equal(foreign.connections, 0)
      assert.deepEqual(results, [])
    } finally {
      releaseReply(String(foreign.port))
      resolver.destroy()
      await local.close()
      await foreign.close()
    }
  })
})

describe('Discovery through real gRPC channels and NamedMap calls', function () {
  this.timeout(10000)
  // The loopback peers use plaintext even when the main suite targets a TLS cluster.

  it('uses both discovered proxies with round_robin and fails over when one closes', async () => {
    const first = await proxy(1)
    const second = await proxy(2)
    const ns = await nameService(() => `[127.0.0.1, ${first.port}, 127.0.0.1, ${second.port}]`)
    const session = new Session({ address: `coherence:///127.0.0.1:${ns.port}`,
      tls: { enabled: false },
      readyTimeoutInMillis: 2000, requestTimeoutInMillis: 2000,
      channelOptions: { ...backoff, 'grpc.service_config': JSON.stringify({ loadBalancingConfig: [{ round_robin: {} }] }) } })
    try {
      const cache = session.getMap('round-robin')
      const values = []
      for (let i = 0; i < 30; i++) values.push(await cache.size)
      assert.deepEqual(new Set(values), new Set([1, 2]))
      assert.ok(first.calls >= 5 && second.calls >= 5, 'Both proxies should handle repeated RPCs')
      first.close()
      await delay(100)
      for (let i = 0; i < 5; i++) assert.equal(await cache.size, 2)
    } finally {
      await session.close()
      first.close()
      second.close()
      await ns.close()
    }
    assert.equal(session.closed, true)
    assert.equal(session.channel.getConnectivityState(false), grpc.connectivityState.SHUTDOWN)
  })

  it('rediscovers a replacement proxy, reconnects the same Session, and emits lifecycle events', async () => {
    let current = await proxy(1)
    const ns = await nameService(() => `[127.0.0.1, ${current.port}]`)
    const session = new Session({ address: `coherence:///127.0.0.1:${ns.port}`,
      tls: { enabled: false },
      readyTimeoutInMillis: 3000, requestTimeoutInMillis: 3000, channelOptions: backoff })
    const observed = []
    const lifecycle = event.SessionLifecycleEvent
    for (const name of Object.values(lifecycle)) session.on(name, () => observed.push(name))
    try {
      const cache = session.getCache('reconnect')
      assert.equal(await cache.size, 1)
      await until(() => observed.includes(lifecycle.CONNECTED))
      const disconnected = once(session, lifecycle.DISCONNECTED)
      current.close()
      await disconnected
      current = await proxy(2)
      assert.equal(await cache.size, 2)
      await until(() => observed.includes(lifecycle.RECONNECTED))
      assert.ok(ns.queries.length >= 2, 'The channel should query NameService again')
    } finally {
      await session.close()
      current.close()
      await ns.close()
    }
    assert.deepEqual(observed, [lifecycle.CONNECTED, lifecycle.DISCONNECTED, lifecycle.RECONNECTED, lifecycle.CLOSED])
  })

  it('recovers from an initial lookup failure using the actual channel retry behavior', async () => {
    const target = await proxy(3)
    let attempts = 0
    const ns = await nameService(() => ++attempts === 1 ? '[]' : `[127.0.0.1, ${target.port}]`)
    const session = new Session({ address: `coherence:///127.0.0.1:${ns.port}`,
      tls: { enabled: false },
      readyTimeoutInMillis: 3000, channelOptions: backoff })
    try {
      assert.equal(await session.getCache('initial-failure').size, 3)
      assert.ok(attempts >= 2)
    } finally {
      await session.close()
      target.close()
      await ns.close()
    }
  })

  it('closes the channel during discovery without later callbacks or connections', async () => {
    const ns = await nameService(() => null)
    const session = new Session({ address: `coherence:///127.0.0.1:${ns.port}`,
      tls: { enabled: false }, channelOptions: backoff })
    try {
      session.channel.getConnectivityState(true)
      await until(() => ns.queries.length === 1)
      await session.close()
      assert.equal(await session.waitUntilClosed(), true)
      await until(() => ns.sockets.size === 0)
      await delay(100)
      assert.equal(ns.connections, 1)
      assert.equal(session.channel.getConnectivityState(false), grpc.connectivityState.SHUTDOWN)
    } finally {
      await session.close()
      await ns.close()
    }
  })
})
