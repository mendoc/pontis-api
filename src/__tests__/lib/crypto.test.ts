import { describe, it, beforeEach, afterEach } from 'vitest'
import assert from 'node:assert/strict'

const TEST_KEY = Buffer.alloc(32, 0xab).toString('base64') // 32 bytes, deterministic for tests

describe('crypto — encrypt / decrypt', () => {
  let originalKey: string | undefined

  beforeEach(() => {
    originalKey = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = TEST_KEY
  })

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY
    } else {
      process.env.ENCRYPTION_KEY = originalKey
    }
    // Reset module cache so getKey() re-reads the env var each test
  })

  it('encrypt returns a string with 3 colon-separated hex parts', async () => {
    const { encrypt } = await import('../../lib/crypto')
    const result = encrypt('hello world')
    const parts = result.split(':')
    assert.equal(parts.length, 3)
    // Each part must be non-empty hex
    for (const part of parts) {
      assert.match(part, /^[0-9a-f]+$/i)
    }
  })

  it('decrypt(encrypt(value)) round-trip returns original value', async () => {
    const { encrypt, decrypt } = await import('../../lib/crypto')
    const original = 'secret=value&another=thing'
    assert.equal(decrypt(encrypt(original)), original)
  })

  it('encrypts empty string', async () => {
    const { encrypt, decrypt } = await import('../../lib/crypto')
    assert.equal(decrypt(encrypt('')), '')
  })

  it('encrypts unicode / special characters', async () => {
    const { encrypt, decrypt } = await import('../../lib/crypto')
    const value = 'clé=valeur spéciale 🔑 "quoted" & <escaped>'
    assert.equal(decrypt(encrypt(value)), value)
  })

  it('two encryptions of the same value produce different ciphertexts (random IV)', async () => {
    const { encrypt } = await import('../../lib/crypto')
    const a = encrypt('same')
    const b = encrypt('same')
    assert.notEqual(a, b)
  })

  it('decrypt throws on malformed input (wrong number of parts)', async () => {
    const { decrypt } = await import('../../lib/crypto')
    assert.throws(() => decrypt('not-a-valid-format'), /Invalid encrypted value format/)
  })

  it('decrypt throws on tampered ciphertext', async () => {
    const { encrypt, decrypt } = await import('../../lib/crypto')
    const encrypted = encrypt('tamper-me')
    const parts = encrypted.split(':')
    // Flip last byte of ciphertext
    const tampered = parts[0] + ':' + parts[1] + ':' + parts[2].slice(0, -2) + '00'
    assert.throws(() => decrypt(tampered))
  })

  it('encrypt throws when ENCRYPTION_KEY is missing', async () => {
    delete process.env.ENCRYPTION_KEY
    // Need a fresh import or direct call — use dynamic import trick via re-evaluation
    const { encrypt } = await import('../../lib/crypto')
    assert.throws(() => encrypt('value'), /ENCRYPTION_KEY/)
  })

  it('encrypt throws when ENCRYPTION_KEY is wrong length (not 32 bytes)', async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(16).toString('base64') // only 16 bytes
    const { encrypt } = await import('../../lib/crypto')
    assert.throws(() => encrypt('value'), /32 bytes/)
  })
})
