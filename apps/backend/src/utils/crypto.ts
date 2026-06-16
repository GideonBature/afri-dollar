import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const SALT = 'afri-dollar-salt-pbkdf2';
const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

let cachedSecret: string | undefined;
let cachedKey: Buffer | undefined;

/**
 * Retrieves the 32-byte encryption key from the environment.
 * Throws an error if ENCRYPTION_KEY is not configured.
 * Derives the key using PBKDF2 with a fixed salt and 100,000 iterations, caching the result.
 */
function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('ENCRYPTION_KEY environment variable is not configured.');
  }

  if (cachedKey && cachedSecret === secret) {
    return cachedKey;
  }

  cachedSecret = secret;
  cachedKey = crypto.pbkdf2Sync(secret, SALT, ITERATIONS, KEY_LENGTH, DIGEST);
  return cachedKey;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a colon-separated string format: "iv:authTag:encryptedContent"
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a colon-separated encrypted string format back to plaintext.
 */
export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format. Expected "iv:authTag:encryptedContent"');
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedContent = parts[2];

  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedContent, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
