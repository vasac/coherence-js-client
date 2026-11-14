/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')

// Shared by Mocha and standalone CommonJS packed-consumer checks on Node 22.9.0.
module.exports = function iteratorTests (util) {
  const entries = [[0, false], ['', 0], ['a', ''], ['b', null], ['c', undefined]]
  const tests = []
  const factories = [
    ['entries', map => map.entries(), entries],
    ['keys', map => map.keys(), entries.map(entry => entry[0])],
    ['values', map => map.values(), entries.map(entry => entry[1])],
    ['Symbol.iterator', map => map[Symbol.iterator](), entries]
  ]

  for (const [name, create, expected] of factories) {
    const map = () => new util.HashMap(1, entries)
    tests.push([`${name}: preserves all results, including falsy keys and values`, () => {
      const iterator = create(map())
      assert.equal(iterator[Symbol.iterator](), iterator)
      assert.deepEqual([...iterator], expected)
      assert.deepEqual(iterator.next(), {done: true, value: undefined})
      assert.deepEqual(iterator.next('ignored'), {done: true, value: undefined})
      assert.deepEqual([...create(new util.HashMap())], [])
    }])
    tests.push([`${name}: traverses separate buckets and remains exhausted`, () => {
      const original = new util.HashMap(32, entries)
      const iterator = create(original)
      const project = name === 'keys' ? entry => entry[0]
        : name === 'values' ? entry => entry[1] : entry => entry
      // Compare membership without assuming insertion order across buckets.
      assert.deepEqual(new Set(iterator), new Set(entries.map(project)))
      original.set('later', 42)
      assert.deepEqual(iterator.next(), {done: true, value: undefined})
    }])
    tests.push([`${name}: disposal is repeatable and preserves iteration and the map`, () => {
      const original = map()
      const iterator = create(original)
      const independent = create(original)
      assert.equal(iterator[Symbol.dispose](), undefined)
      assert.equal(iterator[Symbol.dispose](), undefined)
      assert.deepEqual(iterator.next(), {done: false, value: expected[0]})
      assert.equal(iterator[Symbol.dispose](), undefined)
      assert.deepEqual([...iterator], expected.slice(1))
      assert.equal(iterator[Symbol.dispose](), undefined)
      assert.deepEqual(iterator.next(), {done: true, value: undefined})
      assert.deepEqual([...independent], expected)
      assert.deepEqual([...original], entries)
      assert.equal(original.size, entries.length)
      const empty = create(new util.HashMap())
      assert.equal(empty[Symbol.dispose](), undefined)
      assert.deepEqual(empty.next(), {done: true, value: undefined})
    }])
    tests.push([`${name}: disposal calls an optional return method and propagates errors`, () => {
      const iterator = create(map())
      let calls = 0
      iterator.return = function (...args) {
        assert.equal(this, iterator)
        assert.deepEqual(args, [])
        calls++
        return {done: true, value: undefined}
      }
      assert.equal(iterator[Symbol.dispose](), undefined)
      assert.equal(calls, 1)
      const error = new Error('return failed')
      iterator.return = () => { throw error }
      assert.throws(() => iterator[Symbol.dispose](), thrown => thrown === error)
    }])
    tests.push([`${name}: early loop exit leaves iteration resumable like a native Map`, () => {
      const iterator = create(map())
      for (const value of iterator) {
        assert.deepEqual(value, expected[0])
        break
      }
      assert.deepEqual([...iterator], expected.slice(1))
    }])
    tests.push([`${name}: inherits working native iterator helpers`, () => {
      const iterator = create(map())
      assert(iterator instanceof Iterator)
      assert.deepEqual(iterator.map((value, index) => [index, value]).take(2).toArray(),
        expected.slice(0, 2).map((value, index) => [index, value]))
    }])
  }

  tests.push(['HashMap retains object identity, live updates and Map interoperability', () => {
    const key = {id: 1}
    const value = {score: 1}
    const original = new util.HashMap(1, [[key, value]])
    const iterator = original.entries()
    value.score = 2
    original.set('new', false)
    const first = iterator.next()
    assert.equal(first.value[0], key)
    assert.equal(first.value[1], value)
    assert.deepEqual([...iterator], [['new', false]])
    assert.deepEqual(new Map(original), new Map([[key, value], ['new', false]]))
    const seen = []
    original.forEach((v, k, map) => {
      assert.equal(map, original)
      seen.push([k, v])
    })
    assert.deepEqual(seen, [...original])
  }])
  tests.push(['LocalSet retains synchronous and asynchronous iteration through shared key iterators', async () => {
    const set = new util.LocalSet(1, [0, '', false])
    assert.deepEqual([...set], [0, '', false])
    const iterator = set[Symbol.iterator]()
    iterator[Symbol.dispose]()
    assert.deepEqual([...iterator], [0, '', false])
    const asyncIterator = set[Symbol.asyncIterator]()
    asyncIterator[Symbol.dispose]()
    const seen = []
    for await (const value of asyncIterator) seen.push(value)
    assert.deepEqual(seen, [0, '', false])
    const asyncValues = []
    for await (const value of set) asyncValues.push(value)
    assert.deepEqual(asyncValues, [0, '', false])
  }])
  return tests
}
