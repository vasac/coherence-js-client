/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const { BinaryReader, BinaryWriter } = require('google-protobuf')
const { MapEventResponse, MapListenerResponse, PutRequest } = require('../lib/grpc/messages_pb')
const { NamedCacheServiceService } = require('../lib/grpc/services_grpc_pb')

describe('Protobuf wire compatibility and recursion limits', () => {
  // Literal wire fixtures are independent of the generator under test.
  const fixtures = {
    packed: [0x32, 5, 1, 0x96, 1, 0xac, 2],
    unpacked: [0x30, 1, 0x30, 0x96, 1, 0x30, 0xac, 2],
    mixed: [0x32, 1, 1, 0x30, 0x96, 1, 0x32, 2, 0xac, 2]
  }
  for (const [encoding, bytes] of Object.entries(fixtures)) {
    it(`decodes all filter IDs from ${encoding} fields without a preload shim`, () => {
      assert.equal(BinaryReader.prototype.readPackedInt64, undefined)
      const response = MapEventResponse.deserializeBinary(Uint8Array.from(bytes))
      assert.deepEqual(response.getFilteridsList(), [1, 150, 300])
      assert.deepEqual(Array.from(response.serializeBinary()), fixtures.packed)
      const envelope = Buffer.from([0x1a, bytes.length, ...bytes])
      assert.deepEqual(NamedCacheServiceService.events.responseDeserialize(envelope)
        .getEvent().getFilteridsList(), [1, 150, 300])
    })
  }

  it('preserves opaque key, old-value and new-value bytes in nested events', () => {
    const bytes = [0x08, 2, 0x12, 3, 0, 0xff, 0x80,
      0x1a, 2, 0xc3, 0xa9, 0x22, 2, 0, 0xfe, ...fixtures.packed]
    const wire = Buffer.from([0x1a, bytes.length, ...bytes])
    const message = NamedCacheServiceService.events.responseDeserialize(wire)
    const event = message.getEvent()
    assert.equal(event.getId(), 2)
    assert.deepEqual(Array.from(event.getKey_asU8()), [0, 0xff, 0x80])
    assert.deepEqual(Array.from(event.getNewvalue_asU8()), [0xc3, 0xa9])
    assert.deepEqual(Array.from(event.getOldvalue_asU8()), [0, 0xfe])
    assert.equal(event.getKey_asB64(), Buffer.from([0, 0xff, 0x80]).toString('base64'))
    assert.deepEqual(NamedCacheServiceService.events.responseSerialize(message), wire)
  })

  it('preserves byte fields and request tags through the gRPC serializer', () => {
    const request = new PutRequest().setScope('s').setCache('c').setFormat('json')
      .setKey(Uint8Array.from([0, 0xff])).setValue(Buffer.from([0x80, 1]))
    const wire = Buffer.from([10, 1, 115, 18, 1, 99, 26, 4, 106, 115, 111, 110,
      34, 2, 0, 0xff, 42, 2, 0x80, 1])
    assert.deepEqual(NamedCacheServiceService.put.requestSerialize(request), wire)
    const decoded = NamedCacheServiceService.put.requestDeserialize(wire)
    assert.deepEqual(Array.from(decoded.getKey_asU8()), [0, 0xff])
    assert.deepEqual(Array.from(decoded.getValue_asU8()), [0x80, 1])
  })

  function nestedGroups (depth) {
    // Unknown field 15 uses the legacy protobuf group wire type.
    return Buffer.concat([Buffer.alloc(depth, 0x7b), Buffer.alloc(depth, 0x7c)])
  }

  it('skips shallow unknown groups for forward compatibility', () => {
    const bytes = Buffer.concat([nestedGroups(10), Buffer.from(fixtures.packed)])
    assert.deepEqual(MapEventResponse.deserializeBinary(bytes).getFilteridsList(), [1, 150, 300])
  })

  it('rejects deeply nested groups in a generated gRPC response with the patched guard', () => {
    // 201 is far below the VM's stack limit, proving the explicit protobuf depth
    // guard fires; 10000 also covers the advisory's stack-exhaustion payload.
    for (const depth of [201, 10000]) {
      const writer = new BinaryWriter()
      writer.writeBytes(3, nestedGroups(depth))
      assert.throws(() => NamedCacheServiceService.events.responseDeserialize(writer.getResultBuffer()),
        error => error instanceof SyntaxError && /Maximum protobuf recursion depth exceeded/.test(error.message))
    }
  })

  it('rejects a truncated nested message without overflowing the stack', () => {
    assert.throws(() => MapListenerResponse.deserializeBinary(Uint8Array.from([0x1a, 5, 0x12, 4, 1])),
      error => !(error instanceof RangeError) && /Message parsing ended unexpectedly/.test(error.message))
  })
})
