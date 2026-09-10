import test from 'node:test'
import assert from 'node:assert/strict'
import { promptToPiMessage } from '../../src/acp/translate/prompt.js'

test('promptToPiMessage: concatenates text and resource links', () => {
  const { message, images } = promptToPiMessage([
    { type: 'text', text: 'Hello' },
    { type: 'resource_link', uri: 'file:///tmp/foo.txt', name: 'foo' },
    { type: 'text', text: ' world' }
  ])

  assert.equal(message, 'Hello\n[Context] file:///tmp/foo.txt\n world')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: keeps text following a resource link on its own line', () => {
  const { message, images } = promptToPiMessage([
    { type: 'text', text: 'convert the attached file to png first' },
    {
      type: 'resource_link',
      uri: 'file:///tmp/photo.heic',
      name: 'photo.heic',
      mimeType: 'image/heic'
    },
    { type: 'text', text: 'describe this image' }
  ])

  assert.equal(message, 'convert the attached file to png first\n[Context] file:///tmp/photo.heic\ndescribe this image')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: concatenates consecutive text blocks verbatim', () => {
  const { message, images } = promptToPiMessage([
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' world' }
  ])

  assert.equal(message, 'Hello world')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: includes embedded resource text as marker', () => {
  const { message, images } = promptToPiMessage([
    {
      type: 'resource',
      resource: {
        uri: 'file:///tmp/a.txt',
        mimeType: 'text/plain',
        text: 'hi'
      }
    }
  ] as any)

  assert.equal(message, '\n[Embedded Context] file:///tmp/a.txt (text/plain)\nhi')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: includes embedded resource blob as marker', () => {
  const blob = Buffer.from('xyz', 'utf8').toString('base64')

  const { message, images } = promptToPiMessage([
    {
      type: 'resource',
      resource: {
        uri: 'file:///tmp/a.bin',
        mimeType: 'application/octet-stream',
        blob
      }
    }
  ] as any)

  assert.equal(message, '\n[Embedded Context] file:///tmp/a.bin (application/octet-stream, 3 bytes)')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: includes audio as marker', () => {
  const data = Buffer.from('abc', 'utf8').toString('base64')

  const { message, images } = promptToPiMessage([{ type: 'audio', mimeType: 'audio/wav', data }] as any)

  assert.equal(message, '\n[Audio] (audio/wav, 3 bytes) not supported by pi-acp')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: maps image to pi image content', () => {
  const base64 = Buffer.from('abc', 'utf8').toString('base64')

  const { message, images } = promptToPiMessage([
    { type: 'text', text: 'see' },
    { type: 'image', mimeType: 'image/png', data: base64, uri: 'img-1' }
  ])

  assert.equal(message, 'see')
  assert.equal(images.length, 1)
  assert.deepEqual(images[0], {
    type: 'image',
    mimeType: 'image/png',
    data: base64
  })
})
