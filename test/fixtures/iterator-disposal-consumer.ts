/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

/// <reference lib="esnext.disposable" />
/// <reference lib="esnext.iterator" />

import assert from 'node:assert/strict'
import { util } from '@oracle/coherence'

const hash = new util.HashMap<string, number>(1, [['a', 1], ['b', 2]])
const iterator = hash.values()
{
  using resource = iterator
  assert.equal(resource[Symbol.iterator](), iterator)
  assert.deepEqual(resource.next(), {done: false, value: 1})
}
// Map iterators have no return() method; disposal leaves them resumable.
assert.deepEqual(iterator.next(), {done: false, value: 2})
iterator[Symbol.dispose]()
assert.deepEqual(iterator.next(), {done: true, value: undefined})
const doubled: number[] = hash.values().map(value => value * 2).toArray()
assert.deepEqual(doubled, [2, 4])
assert.deepEqual(hash.keys().take(1).toArray(), ['a'])
assert.deepEqual(hash.entries().map(([key, value]) => `${key}:${value}`).toArray(), ['a:1', 'b:2'])
assert.deepEqual(hash[Symbol.iterator]().map(([key]) => key).toArray(), ['a', 'b'])
