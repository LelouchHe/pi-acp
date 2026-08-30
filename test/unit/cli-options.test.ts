import test from 'node:test'
import assert from 'node:assert/strict'
import { parseAdapterOptions } from '../../src/cli-options.js'

test('parseAdapterOptions keeps optional adapter capabilities disabled by default', () => {
  assert.deepEqual(parseAdapterOptions([]), {
    approveProject: false,
    includeExtensionCommands: false
  })
})

test('parseAdapterOptions enables project approval and extension commands explicitly', () => {
  assert.deepEqual(parseAdapterOptions(['--approve', '--extension-commands']), {
    approveProject: true,
    includeExtensionCommands: true
  })
})
