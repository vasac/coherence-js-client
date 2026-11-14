/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

// TypeDoc 0.28.20 calls matchOne(), removed by the patched minimatch 11.
// Keep traversal's non-negated, partial matching through the public API.
// Remove this patch with the minimatch override once TypeDoc supports it.
const root = path.dirname(require.resolve('typedoc/package.json'))
if (require(path.join(root, 'package.json')).version !== '0.28.20') {
  throw new Error('Review the TypeDoc minimatch compatibility patch before upgrading TypeDoc')
}
const file = path.join(root, 'dist/node-utils.js')
const original = fs.readFileSync(file, 'utf8')
const edits = [[
  '  const mini = new Minimatch2(pattern);',
  `  const mini = new Minimatch2(pattern);
  const partialMini = new Minimatch2(pattern, { partial: true, flipNegate: true });`
], [
  `      return mini.set.some((row) => mini.matchOne(
        childPath,
        row,
        /* partial */
        true
      ));`,
  '      return partialMini.match(childPath.join("/"));'
]]
const digest = source => createHash('sha256').update(source).digest('hex')
// Require the exact published file, or that exact file with our patch applied.
const restored = edits.reduce((source, [before, after]) => source.replace(after, before), original)
if (digest(restored) !== '44982772d80190c9065e29081826b9586c2f65ab71a8d4dd0bbfdeecfecd9ebc') {
  throw new Error('Unexpected TypeDoc source; review the minimatch compatibility patch')
}
const patched = edits.reduce((source, [before, after]) => {
  if (!source.includes(before)) throw new Error('TypeDoc patch target missing')
  return source.replace(before, after)
}, restored)
if (original === patched) {
  console.log('TypeDoc minimatch compatibility patch already applied')
} else if (original === restored) {
  fs.writeFileSync(file, patched)
  console.log('Applied TypeDoc minimatch compatibility patch')
} else {
  throw new Error('Incomplete TypeDoc compatibility patch; reinstall with npm ci')
}
