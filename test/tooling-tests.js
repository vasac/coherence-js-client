/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const TestExclude = createRequire(require.resolve('nyc/package.json'))('test-exclude')

const root = path.resolve(__dirname, '..')

describe('Development tool file selection', function () {
  this.timeout(15000)

  it('discovers the regular and recursive Mocha suites, including brace patterns', async () => {
    const { lookupFiles } = await import('mocha/lib/cli/lookup-files.js')
    const expected = fs.readdirSync(__dirname).filter(file => file.endsWith('.js')).sort()
    const regular = lookupFiles('test/**.js', ['js'], true)
    assert.deepEqual(regular.map(file => path.basename(file)).sort(), expected)
    const recursive = lookupFiles('test', ['js'], true)
    const all = fs.readdirSync(__dirname, { recursive: true }).filter(file => file.endsWith('.js'))
    assert.deepEqual(recursive.map(file => path.relative(__dirname, path.resolve(file))).sort(), all.sort())
    assert(recursive.some(file => file.endsWith('discovery/resolver-tests.js')))
    assert.deepEqual(lookupFiles('test/{protobuf-tests,resolver-unit-tests}.*', ['js'], true)
      .map(file => path.basename(file)).sort(), ['protobuf-tests.js', 'resolver-unit-tests.js'])
    const collectFiles = require('mocha/lib/cli/collect-files.cjs')
    const filtered = collectFiles({ spec: ['test/**/*.js'], extension: ['js'], recursive: true,
      ignore: ['**/{discovery,helpers}/**', '**/protobuf-tests.js'], file: [] }).files
    assert.deepEqual(filtered.map(file => path.basename(file)).sort(),
      expected.filter(file => file !== 'protobuf-tests.js'))
  })

  it('selects project code for NYC while excluding generated code, tests and dependencies', async () => {
    const exclude = new TestExclude({ cwd: root, ...JSON.parse(fs.readFileSync(path.join(root, '.nycrc'))) })
    for (const file of ['lib/session.js', 'lib/util.js', 'src/session.ts']) {
      assert(exclude.shouldInstrument(path.join(root, file)), file)
    }
    for (const file of ['src/grpc/messages_pb.d.ts', 'lib/grpc/messages_pb.js',
      'test/protobuf-tests.js', 'test/discovery/resolver-tests.js', 'node_modules/mocha/index.js']) {
      assert.equal(exclude.shouldInstrument(path.join(root, file)), false, file)
    }
    const sync = exclude.globSync().sort()
    assert.deepEqual((await exclude.glob()).sort(), sync)
    assert(sync.includes('lib/session.js'))
    assert(!sync.some(file => /(^|\/)(grpc|test|node_modules)\//.test(file)))
  })

  it('expands TypeDoc entry points and applies the configured generated-code filter', async () => {
    const { Application } = await import('typedoc')
    const options = require('../typedoc.json')
    const app = await Application.bootstrap({ ...options, entryPoints: ['./src/**/*.ts'], entryPointStrategy: 'expand' })
    const selected = () => app.getEntryPoints().map(entry => path.relative(root, entry.sourceFile.fileName)).sort()
    const expected = fs.readdirSync(path.join(root, 'src')).filter(file => file.endsWith('.ts'))
      .map(file => 'src/' + file).sort()
    assert.deepEqual(selected(), expected)
    app.options.setValue('exclude', [])
    assert(selected().some(file => file.startsWith('src/grpc/')))
    app.options.setValue('exclude', [...options.exclude, '**/filters.ts'])
    assert.deepEqual(selected(), expected.filter(file => file !== 'src/filters.ts'))
    assert.equal(app.logger.hasErrors(), false)
  })
})
