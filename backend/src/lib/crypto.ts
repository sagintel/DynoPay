import crypto from 'node:crypto';
import { env, isProd } from '../config/env.js';
import { logger } from './logger.js';

/**
 * AES-256-GCM for secrets at rest (merchant REST API secrets).
 * Key: CREDENTIALS_ENCRYPTION_KEY (32 bytes, base64). Required in production; in development it
 * is derived from JWT_SECRET so the app runs out of the box.
 */
function loadKey(): Buffer {
  if (env.CREDENTIALS_ENCRYPTION_KEY) {
    const key = Buffer.from(env.CREDENTIALS_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
    return key;
  }
  if (isProd) throw new Error('CREDENTIALS_ENCRYPTION_KEY is required in production');
  logger.warn('CREDENTIALS_ENCRYPTION_KEY not set; deriving a development key from JWT_SECRET');
  return Buffer.from(crypto.hkdfSync('sha256', env.JWT_SECRET, 'dynopay', 'credentials-v1', 32));
}

let key: Buffer | null = null;
const getKey = () => (key ??= loadKey());

/** Returns "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
