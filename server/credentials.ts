import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { Wallet, getAddress } from 'ethers';

export interface CredentialInput {
  predictFunApiKey: string;
  /** Empty for PAPER market data; a signing key is required for LIVE. */
  walletPrivateKey?: string;
  predictAccountAddress?: string;
}

export interface BotCredentials {
  predictFunApiKey: string;
  walletPrivateKey: string;
  predictAccountAddress: string;
  /** Derived signer address, distinct from the optional Predict smart account. */
  walletAddress: string;
}

export interface SealedCredentials {
  version: 1;
  algorithm: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialsError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'KEY_NOT_CONFIGURED' | 'INVALID_ENVELOPE' | 'DECRYPTION_FAILED', message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

function invalid(message: string): never { throw new CredentialsError('INVALID_INPUT', message); }

export function validateCredentials(input: unknown): BotCredentials {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Credentials must be an object.');
  const value = input as Record<string, unknown>;
  if (typeof value.predictFunApiKey !== 'string') invalid('PREDICT_FUN_API_KEY is required.');
  const predictFunApiKey = value.predictFunApiKey.trim();
  if (predictFunApiKey.length < 8 || predictFunApiKey.length > 1024 || /\s|[\u0000-\u001f\u007f]/.test(predictFunApiKey)) {
    invalid('PREDICT_FUN_API_KEY must contain 8–1024 non-whitespace characters.');
  }
  if (value.walletPrivateKey !== undefined && typeof value.walletPrivateKey !== 'string') invalid('WALLET_PRIVATE_KEY must be a signing key or empty for PAPER.');
  const privateKey = String(value.walletPrivateKey ?? '').trim();
  let wallet: Wallet | null = null;
  if (privateKey) {
    const rawKey = privateKey.replace(/^0x/i, '');
    if (!/^[a-fA-F0-9]{64}$/.test(rawKey)) invalid('WALLET_PRIVATE_KEY must be a valid 32-byte hex key.');
    try { wallet = new Wallet(`0x${rawKey}`); }
    catch { invalid('WALLET_PRIVATE_KEY is not a valid signing key.'); }
  }
  if (value.predictAccountAddress !== undefined && typeof value.predictAccountAddress !== 'string') invalid('PREDICT_ACCOUNT_ADDRESS must be an address or empty for an EOA.');
  const account = String(value.predictAccountAddress ?? '').trim();
  if (account && !wallet) invalid('PREDICT_ACCOUNT_ADDRESS requires a signing key. Leave both wallet fields empty for PAPER.');
  let predictAccountAddress = '';
  if (account) {
    try { predictAccountAddress = getAddress(account); }
    catch { invalid('PREDICT_ACCOUNT_ADDRESS is not a valid address.'); }
  }
  return { predictFunApiKey, walletPrivateKey: wallet?.privateKey || '', predictAccountAddress, walletAddress: wallet?.address || '' };
}

/** Only a complete environment credential bundle can be used for signing. */
export function credentialsFromEnvironment(env: NodeJS.ProcessEnv = process.env): BotCredentials | null {
  if (!env.PREDICT_FUN_API_KEY?.trim() || !env.WALLET_PRIVATE_KEY?.trim()) return null;
  return validateCredentials({ predictFunApiKey: env.PREDICT_FUN_API_KEY, walletPrivateKey: env.WALLET_PRIVATE_KEY, predictAccountAddress: env.PREDICT_ACCOUNT_ADDRESS || '' });
}

/** Opaque proof identity binds authentication to the exact key bundle, including environment rotations. */
export function credentialProofId(input: BotCredentials, env: NodeJS.ProcessEnv = process.env): string {
  const value = validateCredentials(input);
  if (!value.walletPrivateKey) invalid('LIVE authentication proof requires a signing key.');
  const dedicated = env.BOT_CREDENTIALS_KEY?.trim();
  const key = dedicated && /^[a-fA-F0-9]{64}$/.test(dedicated) ? Buffer.from(dedicated, 'hex') : Buffer.from(env.BOT_CONTROL_TOKEN || '');
  if (key.length < 24) throw new CredentialsError('KEY_NOT_CONFIGURED', 'Server identity key is not configured.');
  try {
    return createHmac('sha256', key).update('predict-auth-proof/v1|').update(JSON.stringify([value.predictFunApiKey, value.walletPrivateKey, value.predictAccountAddress.toLowerCase()])).digest('hex');
  } finally { key.fill(0); }
}

/** Deliberately contains no private key, API key, ciphertext, or masked fragments. */
export function getSecretStatus(credentials?: BotCredentials | null): {
  predictFunApiKeyConfigured: boolean;
  walletPrivateKeyConfigured: boolean;
  predictAccountAddressConfigured: boolean;
  walletAddress: string | null;
} {
  if (!credentials) return { predictFunApiKeyConfigured: false, walletPrivateKeyConfigured: false, predictAccountAddressConfigured: false, walletAddress: null };
  const normalized = validateCredentials(credentials);
  return {
    predictFunApiKeyConfigured: true, walletPrivateKeyConfigured: !!normalized.walletPrivateKey,
    predictAccountAddressConfigured: !!normalized.predictAccountAddress,
    walletAddress: normalized.predictAccountAddress || normalized.walletAddress || null,
  };
}

function encryptionKey(salt: Buffer, env: NodeJS.ProcessEnv): Buffer {
  const dedicated = env.BOT_CREDENTIALS_KEY?.trim();
  if (dedicated) {
    if (!/^[a-fA-F0-9]{64}$/.test(dedicated)) throw new CredentialsError('KEY_NOT_CONFIGURED', 'BOT_CREDENTIALS_KEY must be exactly 64 hex characters.');
    return Buffer.from(dedicated, 'hex');
  }
  const password = env.BOT_CONTROL_TOKEN;
  if (typeof password !== 'string' || password.length < 24 || password.length > 4096) {
    throw new CredentialsError('KEY_NOT_CONFIGURED', 'Set BOT_CONTROL_TOKEN to at least 24 characters before saving credentials.');
  }
  return scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function associatedData(salt: string): Buffer { return Buffer.from(`predict-fun/bot-credentials/v1|aes-256-gcm|${salt}`, 'utf8'); }

function decode(value: unknown, exactBytes?: number, maxBytes = 4096): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new CredentialsError('INVALID_ENVELOPE', 'Stored encrypted credentials have an invalid format.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || exactBytes !== undefined && bytes.length !== exactBytes || bytes.length > maxBytes) {
    throw new CredentialsError('INVALID_ENVELOPE', 'Stored encrypted credentials have an invalid format.');
  }
  return bytes;
}

/** Schema-only check used by the state store; it does not decrypt credentials. */
export function validateSealedCredentials(value: unknown): SealedCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CredentialsError('INVALID_ENVELOPE', 'Stored encrypted credentials have an invalid format.');
  const envelope = value as Record<string, unknown>;
  const keys = Object.keys(envelope).sort().join(',');
  if (keys !== 'algorithm,ciphertext,iv,salt,tag,version' || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new CredentialsError('INVALID_ENVELOPE', 'Stored encrypted credentials use an unsupported format.');
  }
  decode(envelope.salt, 16); decode(envelope.iv, 12); decode(envelope.tag, 16); decode(envelope.ciphertext);
  return structuredClone(envelope) as unknown as SealedCredentials;
}

export function sealCredentials(input: CredentialInput | BotCredentials, env: NodeJS.ProcessEnv = process.env): SealedCredentials {
  const credentials = validateCredentials(input);
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = encryptionKey(salt, env);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const saltText = salt.toString('base64');
    cipher.setAAD(associatedData(saltText));
    const plaintext = JSON.stringify({ predictFunApiKey: credentials.predictFunApiKey, walletPrivateKey: credentials.walletPrivateKey, predictAccountAddress: credentials.predictAccountAddress });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { version: 1, algorithm: 'aes-256-gcm', salt: saltText, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { key.fill(0); }
}

export function unsealCredentials(input: unknown, env: NodeJS.ProcessEnv = process.env): BotCredentials {
  const envelope = validateSealedCredentials(input);
  const key = encryptionKey(decode(envelope.salt, 16), env);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
    decipher.setAAD(associatedData(envelope.salt));
    decipher.setAuthTag(decode(envelope.tag, 16));
    const plaintext = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]);
    try { return validateCredentials(JSON.parse(plaintext.toString('utf8'))); }
    finally { plaintext.fill(0); }
  } catch {
    // Never fall back to another key or a different environment wallet. Operators
    // must re-enter credentials after key rotation or failed authentication.
    throw new CredentialsError('DECRYPTION_FAILED', 'Stored credentials cannot be decrypted. Re-enter them after checking the server encryption key.');
  } finally { key.fill(0); }
}
