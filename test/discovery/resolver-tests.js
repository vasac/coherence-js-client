/*
 * Copyright (c) 2025, 2026, Oracle and/or its affiliates.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const { CoherenceResolver, Session } = require('../../lib')
const assert = require('assert').strict
const { describe, it } = require('mocha');

describe('CoherenceResolver Test Suite (unit/IT)', function () {
  this.timeout(15000)
  const proxyPort = Number(process.env.COHERENCE_DISCOVERY_PROXY_PORT || 10000)
  const foreignCluster = process.env.COHERENCE_DISCOVERY_FOREIGN_CLUSTER || 'grpc-cluster2'
  const foreignPort = Number(process.env.COHERENCE_DISCOVERY_FOREIGN_PORT || 10001)
  describe('A CoherenceResolver', () => {

    function resolveProxy(path, expectedPort) {
      return new Promise((resolve, reject) => {
        const resolver = new CoherenceResolver({scheme: 'coherence', path},
          (result, attributes, serviceConfig, resolutionNote) => {
            resolver.destroy()
            try {
              assert.equal(result.ok, true, result.error?.details)
              assert.equal(result.value.length, 1)
              assert.equal(result.value[0].addresses[0].host, '127.0.0.1')
              assert.equal(result.value[0].addresses[0].port, expectedPort)
              assert.deepEqual(attributes, {})
              assert.equal(serviceConfig, null)
              assert.equal(resolutionNote, '')
              resolve()
            } catch (error) {
              reject(error)
            }
            return true
          }, {})
        resolver.updateResolution()
      })
    }

    it('should parse and resolve the connection format \'coherence:///[host]\'', async () => {
      await resolveProxy('localhost', proxyPort)
    })

    it('should parse and resolve the connection format \'coherence:///[host]:[port]\'', async () => {
      await resolveProxy('localhost:7574', proxyPort)
    })

    it('should parse and resolve the connection format \'coherence:///[host]/[clusterName]\'', async () => {
      await resolveProxy(`localhost/${foreignCluster}`, foreignPort)
    })

    it('should parse and resolve the connection format \'coherence:///[host]:[port]/[clusterName]\'', async () => {
      await resolveProxy(`localhost:7574/${foreignCluster}`, foreignPort)
    })
  })

  describe('A Session', () => {
    it('should be able to resolve the gRPC Proxy', async () => {
      const session = new Session({address: 'coherence:///localhost'})
      const cache = session.getCache('test')
      try {
        await cache.set('a', 'b')
        assert.equal(await cache.get('a'), 'b')
      } finally {
        await session.close()
      }
    })

    it('should be able to resolve the gRPC Proxy of a foreign cluster', async () => {
      const session = new Session({address: `coherence:///localhost/${foreignCluster}`})
      const cache = session.getCache('test')
      try {
        await cache.set('a', 'b')
        assert.equal(await cache.get('a'), 'b')
      } finally {
        await session.close()
      }
    })
  })
})
