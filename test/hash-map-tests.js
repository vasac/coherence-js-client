/*
 * Copyright (c) 2026, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

const { util } = require('../lib')
const iteratorTests = require('./helpers/hash-map-iterators')

describe('HashMap iterator contracts', () => {
  for (const [name, test] of iteratorTests(util)) it(name, test)
})
