/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const manifest = require('../etc/proto/manifest.json')
const protoDir = path.join(root, 'etc/proto')

function verify (file, expected) {
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${file}: expected ${expected}, received ${actual}`)
  }
}

function run (command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function generate () {
  const grpcTools = path.dirname(require.resolve('grpc-tools/package.json'))
  for (const [file, digest] of Object.entries(manifest.schemas)) {
    verify(path.join(protoDir, file), digest)
  }
  for (const [file, digest] of Object.entries(manifest.imports)) {
    verify(path.join(grpcTools, 'bin', file), digest)
  }
  if (require('google-protobuf/package.json').version !== manifest.generator.version) {
    throw new Error('The protobuf runtime and JavaScript generator versions must match')
  }
  const target = `${process.platform}-${process.arch}`
  const artifact = manifest.generator.artifacts[target]
  if (!artifact) {
    throw new Error(`No verified protoc-gen-js binary for ${target}; build on Linux or macOS`)
  }

  const cache = path.join(root, 'node_modules/.cache/coherence-protobuf')
  fs.mkdirSync(cache, { recursive: true })
  const staging = fs.mkdtempSync(path.join(cache, 'generate-'))
  try {
    // Cache the archive, not an unchecked executable. Verify before every extraction.
    const archive = path.join(cache, artifact.file)
    if (!fs.existsSync(archive)) {
      const download = path.join(staging, 'download.tar.gz')
      const url = `${manifest.generator.url}/${artifact.file}`
      console.log(`Downloading protoc-gen-js ${manifest.generator.version} for ${target}`)
      run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3',
        '--connect-timeout', '15', '--max-time', '120', '--proto', '=https',
        '--proto-redir', '=https', url, '--output', download])
      verify(download, artifact.sha256)
      fs.renameSync(download, archive)
    }
    verify(archive, artifact.sha256)
    run('tar', ['-xzf', archive, '-C', staging, 'bin/protoc-gen-js'])
    const jsPlugin = path.join(staging, 'bin/protoc-gen-js')
    fs.chmodSync(jsPlugin, 0o755)

    const declarations = path.join(staging, 'declarations')
    const javascript = path.join(staging, 'javascript')
    fs.mkdirSync(declarations)
    fs.mkdirSync(javascript)
    // Use an alias: protoc's built-in "js" generator takes precedence over --plugin.
    run(process.execPath, [path.join(grpcTools, 'bin/protoc.js'),
      `--plugin=protoc-gen-coherence-js=${jsPlugin}`,
      `--plugin=protoc-gen-ts=${path.join(root, 'node_modules/.bin/protoc-gen-ts')}`,
      `--ts_out=grpc_js:${declarations}`,
      `--coherence-js_out=import_style=commonjs,binary:${javascript}`,
      `--grpc_out=grpc_js:${javascript}`,
      '-I', protoDir, '-I', path.join(grpcTools, 'bin'),
      ...Object.keys(manifest.schemas)])

    for (const file of ['messages_pb.js', 'services_pb.js', 'services_grpc_pb.js']) {
      if (!fs.statSync(path.join(javascript, file)).size) throw new Error(`Empty generated ${file}`)
    }
    for (const file of ['messages_pb.d.ts', 'services_pb.d.ts', 'services_grpc_pb.d.ts']) {
      const source = path.join(declarations, file)
      if (!fs.statSync(source).size) throw new Error(`Empty generated ${file}`)
      fs.copyFileSync(source, path.join(javascript, file))
    }
    // Keep the previous output until every generator has completed successfully.
    for (const [source, destination] of [[declarations, 'src/grpc'], [javascript, 'lib/grpc']]) {
      const output = path.join(root, destination)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.rmSync(output, { recursive: true, force: true })
      fs.renameSync(source, output)
    }
    console.log(`Generated Coherence stubs with protoc-gen-js ${manifest.generator.version}`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

try {
  generate()
} catch (error) {
  console.error(`Protobuf generation failed: ${error.message}`)
  process.exitCode = 1
}
