/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const { Session, Filters, event, filter } = require('../lib')

describe('Protobuf filtered listener integration', function () {
  this.timeout(15000)

  it('dispatches multiple matching filter IDs and removes filter and key listeners', async () => {
    const session = new Session()
    const cache = session.getCache(`protobuf-listeners-${process.pid}-${Date.now()}`)
    const firstFilter = Filters.event(Filters.always(), filter.MapEventFilter.ALL)
    const secondFilter = Filters.event(Filters.greaterEqual('score', 1), filter.MapEventFilter.ALL)
    const key = 'key-\u0000-wire'
    const received = [[], [], []]
    const listeners = received.map(events => {
      const listener = new event.MapListener()
      for (const type of [event.MapEventType.INSERT, event.MapEventType.UPDATE, event.MapEventType.DELETE]) {
        listener.on(type, e => events.push({ id: e.id, key: e.key, old: e.oldValue, value: e.newValue }))
      }
      return listener
    })
    // Observe the decoded server response too: callback counts alone do not prove
    // that one response carried multiple filter IDs.
    const wireIds = []
    const handler = cache.mapEventsHandler
    const handleResponse = handler.handleResponse.bind(handler)
    handler.handleResponse = response => {
      if (response.hasEvent()) wireIds.push([...response.getEvent().getFilteridsList()])
      handleResponse(response)
    }

    async function waitForCount (events, count) {
      const deadline = Date.now() + 4000
      while (events.length < count && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(events.length, count, 'Listener did not receive the expected number of events')
    }

    const one = { score: 1, text: 'nul\u0000-wire' }
    const two = { score: 2, text: 'updated' }
    const expected = [
      { id: 1, key, old: null, value: one },
      { id: 2, key, old: one, value: two },
      { id: 3, key, old: two, value: null }
    ]
    async function mutate () {
      await cache.set(key, one)
      await cache.set(key, two)
      await cache.delete(key)
    }

    try {
      await cache.addMapListener(listeners[0], firstFilter)
      await cache.addMapListener(listeners[1], secondFilter)
      await cache.addMapListener(listeners[2], key)
      await mutate()
      for (const events of received) {
        await waitForCount(events, 3)
        assert.deepEqual(events, expected)
      }
      assert.equal(wireIds.length, 3)
      const initialIds = [...wireIds[0]].sort((a, b) => a - b)
      assert.equal(new Set(initialIds).size, 2)
      for (const ids of wireIds) assert.deepEqual([...ids].sort((a, b) => a - b), initialIds)

      await cache.removeMapListener(listeners[0], firstFilter)
      await cache.removeMapListener(listeners[2], key)
      await mutate()
      await waitForCount(received[1], 6)
      assert.deepEqual(received[0], expected)
      assert.deepEqual(received[2], expected)
      assert.deepEqual(received[1], [...expected, ...expected])
      assert.equal(wireIds.length, 6)
      const remaining = wireIds[3]
      assert.equal(remaining.length, 1)
      assert.ok(initialIds.includes(remaining[0]))
      for (const ids of wireIds.slice(3)) assert.deepEqual(ids, remaining)
      await cache.removeMapListener(listeners[1], secondFilter)
    } finally {
      try {
        if (cache.active) await cache.destroy()
      } finally {
        await session.close()
      }
    }
  })
})
