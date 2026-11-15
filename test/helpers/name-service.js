/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const net = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')

function packed (value) {
  const bytes = [value & 63]
  value = Math.floor(value / 64)
  while (value) {
    bytes[bytes.length - 1] |= 128
    bytes.push(value & 127)
    value = Math.floor(value / 128)
  }
  return Buffer.from(bytes)
}

function unpack (buffer) {
  let value = 0
  for (let i = 0; i < buffer.length; i++) {
    value += (buffer[i] & (i ? 127 : 63)) * 2 ** (i ? 6 + 7 * (i - 1) : 0)
    if (!(buffer[i] & 128)) return [value, i + 1]
  }
  return null
}

// A loopback NameService protocol peer, with real TCP framing. Tests can split
// frames or return bad replies without depending on a Coherence installation.
async function nameService (lookup, { fragment = false, response = (_, frame) => frame } = {}) {
  const sockets = new Set()
  const queries = []
  let connections = 0
  const errors = []
  const server = net.createServer(socket => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {}) // A client may cancel a fragmented response.
    let buffer = Buffer.alloc(0)
    let phase = -1
    let processing = false

    async function send (payload) {
      const frame = response(phase, Buffer.concat([packed(payload.length), payload]))
      const chunks = fragment ? [frame.subarray(0, 1), frame.subarray(1, 2),
        frame.subarray(2, 5), frame.subarray(5)] : [frame]
      for (const chunk of chunks) {
        if (socket.destroyed) return
        socket.write(chunk)
        if (fragment) await delay(2)
      }
    }

    async function processFrames () {
      if (processing) return
      processing = true
      try {
        if (phase === -1) {
          if (buffer.length < 8) return
          assert.deepEqual(buffer.subarray(0, 8), Buffer.from([90, 193, 224, 0, 0, 0, 0, 3]))
          buffer = buffer.subarray(8)
          phase = 0
        }
        while (!socket.destroyed) {
          const header = unpack(buffer)
          if (!header || buffer.length < header[0] + header[1]) return
          const payload = buffer.subarray(header[1], header[0] + header[1])
          buffer = buffer.subarray(header[0] + header[1])
          if (phase === 0) {
            await send(Buffer.from([0]))
          } else if (phase === 1) {
            await send(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 64]))
          } else {
            const [length, bytes] = unpack(payload.subarray(8))
            const query = payload.subarray(8 + bytes, 8 + bytes + length).toString()
            queries.push(query)
            const result = await lookup(query, socket)
            if (result !== null && !socket.destroyed) {
              const text = Buffer.from(result)
              await send(Buffer.concat([Buffer.alloc(8), packed(text.length), text, Buffer.from([64])]))
            }
          }
          phase++
        }
      } catch (error) {
        errors.push(error)
        socket.destroy()
      } finally {
        processing = false
      }
    }
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data])
      void processFrames()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port, sockets, queries,
    get connections () { return connections },
    async close () {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      assert.deepEqual(errors, [], 'NameService test peer failed')
    }
  }
}

module.exports = { nameService }
