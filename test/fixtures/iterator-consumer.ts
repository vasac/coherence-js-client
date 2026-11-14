/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

import { util, Session, Filters, event, NamedMap } from '@oracle/coherence'
import { NamedCacheServiceClient, NamedCacheServiceService } from '@oracle/coherence/lib/grpc/services_grpc_pb'
import { PutRequest, MapListenerRequest } from '@oracle/coherence/lib/grpc/messages_pb'

const hash = new util.HashMap<string, number>(4, [['a', 1], ['b', 2]])
const map: Map<string, number> = hash
const entries: MapIterator<[string, number]> = hash.entries()
const keys: MapIterator<string> = hash.keys()
const values: MapIterator<number> = hash.values()
const iterator: MapIterator<[string, number]> = hash[Symbol.iterator]()
const self: MapIterator<string> = keys[Symbol.iterator]()
for (const [key, value] of map) console.log(key, value)
for (const key of keys) console.log(key)
for (const value of values) console.log(value)
console.log(entries.next(), iterator.next(), self.next())

const result = hash.values().next()
if (result.done) {
  const completed: undefined = result.value
  void completed
} else {
  const yielded: number = result.value
  void yielded
}
// @ts-expect-error A possibly exhausted iterator must be narrowed before reading a number.
const unchecked: number = hash.values().next().value
void unchecked

const local = new util.LocalSet<number>(4, [0, 1])
for (const value of local) console.log(value)
const listener = new event.MapListener<string, number>()
listener.on(event.MapEventType.INSERT, (entry: event.MapEvent<string, number>) => console.log(entry.key, entry.newValue))
function listen (cache: NamedMap<string, number>): Promise<void> {
  return cache.addMapListener(listener, Filters.always())
}
const request = new PutRequest().setCache('test').setKey(Buffer.from('key'))
const wire: Buffer = NamedCacheServiceService.put.requestSerialize(request)
const listenRequest: MapListenerRequest = new MapListenerRequest()
const client: typeof NamedCacheServiceClient = NamedCacheServiceClient
const session: typeof Session = Session
void [listen, wire, listenRequest, client, session]
