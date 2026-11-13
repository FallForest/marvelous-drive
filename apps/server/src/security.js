import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes,
  scrypt as scryptCallback, timingSafeEqual,
} from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { config } from './config.js'

const scrypt = promisify(scryptCallback)

/**
 * Password hashing and JWT signing.
 *
 * Hashes are `scrypt:<salt>:<hex>`: the salt is 16 random bytes and the derived
 * key 64 bytes, both hex encoded. Verification is constant time.
 */

export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex')
  const key = await scrypt(password, salt, 64)
  return `scrypt:${salt}:${key.toString('hex')}`
}

export async function passwordMatches(password, encoded) {
  const [scheme, salt, expectedHex] = String(encoded || '').split(':')
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false
  const actual = await scrypt(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A stable secret across restarts, generated on first boot. */
function loadSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET
  if (existsSync(config.jwtSecretPath)) return readFileSync(config.jwtSecretPath, 'utf8').trim()
  const secret = randomBytes(32).toString('hex')
  writeFileSync(config.jwtSecretPath, secret, { mode: 0o600 })
  return secret
}

const secret = loadSecret()

const b64url = (value) => Buffer.from(value).toString('base64url')

export function signToken(claims) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const body = `${header}.${payload}`
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null
    if (!claims.sub) return null
    return claims
  } catch { return null }
}

export const randomId = () => randomBytes(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url')

/* ── at-rest encryption for node tokens ───────────────────────────────── */

/**
 * Encrypts a secret that the coordinator must replay later.
 *
 * A storage node's token is not a password: it must be *presented* on every
 * request, so it cannot be stored as a one-way hash. It also must not sit in
 * plaintext, because a database dump would then hand over every node's disk.
 *
 * AES-256-GCM with the JWT secret as key material, a fresh random IV per record,
 * and the tag kept alongside — the standard "encrypt a small secret at rest"
 * shape. Rotating the secret invalidates every node token, which is the correct
 * consequence: a new key means a new enrolment.
 */
const nodeKey = createHash('sha256').update('mdrive-node-token\0' + secret).digest()

export function sealSecret(plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', nodeKey, iv)
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'v1:' + iv.toString('base64url') + ':' + tag.toString('base64url') + ':' + encrypted.toString('base64url')
}

/** Returns the plaintext, or null when the record is absent, corrupt or from another key. */
export function openSecret(sealed) {
  try {
    const [version, ivText, tagText, bodyText] = String(sealed || '').split(':')
    if (version !== 'v1' || !ivText || !tagText || !bodyText) return null
    const decipher = createDecipheriv('aes-256-gcm', nodeKey, Buffer.from(ivText, 'base64url'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
