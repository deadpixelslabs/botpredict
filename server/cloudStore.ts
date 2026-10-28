import { publicConfig, validateControlConfig } from './controlConfig';
import { BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';
import { validateSealedCredentials, type SealedCredentials } from './credentials';

export interface BlobJsonAdapter {
  read(path: string): Promise<{ value: unknown; etag: string } | null>;
  write(path: string, value: unknown, options: { ifMatch?: string; createOnly?: boolean }): Promise<{ etag: string }>;
}

export interface CloudCommand {
  id: string;
  type: 'config' | 'clearLogs';
  payload?: Record<string, unknown>;
  createdAt: number;
  status?: 'pending' | 'applied' | 'failed';
  error?: string;
  appliedAt?: number;
}

export interface CloudState {
  schemaVersion: 1;
  revision: number;
  updatedAt: number;
  config: Record<string, any>;
  ledger: any[];
  commands: CloudCommand[];
  status: Record<string, any>;
  sealedCredentials?: SealedCredentials;
  credentialRevision?: number;
}

interface StoredState extends CloudState {
  lease?: { owner: string; expiresAt: number; generation: number };
}

export class CloudStoreError extends Error {
  constructor(public readonly code: 'NOT_CONFIGURED' | 'READ_FAILED' | 'WRITE_FAILED' | 'CORRUPT_STATE' | 'CONFLICT' | 'LEASE_LOST', message: string) {
    super(message);
    this.name = 'CloudStoreError';
  }
}

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const SENSITIVE_FIELDS = /^(?:walletPrivateKey|private_?key|api_?key|predictFunApiKey|password|authorization|cookie|jwt(?:Token)?|accessToken|refreshToken|secret|signature|.*_API_KEY|.*_PRIVATE_KEY|BOT_CONTROL_TOKEN|BLOB_READ_WRITE_TOKEN)$/i;

export function cloudStorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BLOB_STORE_ID?.trim() || env.BLOB_READ_WRITE_TOKEN?.trim());
}

function conflict(error: any): boolean {
  return error instanceof BlobPreconditionFailedError || error?.code === 'BLOB_PRECONDITION_FAILED' || error?.status === 409 || error?.status === 412 ||
    ['BlobPreconditionFailedError', 'BlobAlreadyExistsError'].includes(error?.name);
}

async function authentication(): Promise<{ token?: string; storeId?: string; oidcToken?: string }> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token?.trim()) return { token };
  // Daemons rotate OIDC through VERCEL_OIDC_TOKEN_FILE. Explicitly fetch with
  // @vercel/oidc >=4 on EVERY operation; Blob's transitive older helper must not
  // keep the original environment token after it expires.
  const { getVercelOidcToken } = await import('@vercel/oidc');
  return { storeId: process.env.BLOB_STORE_ID, oidcToken: await getVercelOidcToken() };
}

/** Private, uncached Blob reads and conditional writes. No credentials appear in errors. */
export class VercelBlobJsonAdapter implements BlobJsonAdapter {
  async read(path: string): Promise<{ value: unknown; etag: string } | null> {
    if (!cloudStorageConfigured()) throw new CloudStoreError('NOT_CONFIGURED', 'Private storage is not connected to this project.');
    try {
      const { get } = await import('@vercel/blob');
      const result = await get(path, { access: 'private', useCache: false, ...await authentication(), abortSignal: AbortSignal.timeout(8000) });
      if (!result) return null;
      if (result.statusCode !== 200 || !result.blob.etag || result.blob.size > MAX_STATE_BYTES) {
        throw new CloudStoreError('CORRUPT_STATE', 'Stored bot state cannot be read safely.');
      }
      const text = await new Response(result.stream).text();
      if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new CloudStoreError('CORRUPT_STATE', 'Stored bot state exceeds the supported size.');
      try { return { value: JSON.parse(text), etag: result.blob.etag }; }
      catch { throw new CloudStoreError('CORRUPT_STATE', 'Stored bot state is not valid JSON.'); }
    } catch (error: any) {
      if (error instanceof CloudStoreError) throw error;
      if (error instanceof BlobNotFoundError || error?.name === 'BlobNotFoundError') return null;
      throw new CloudStoreError('READ_FAILED', 'Private storage could not be read. Trading must remain paused.');
    }
  }

  async write(path: string, value: unknown, options: { ifMatch?: string; createOnly?: boolean }): Promise<{ etag: string }> {
    if (!cloudStorageConfigured()) throw new CloudStoreError('NOT_CONFIGURED', 'Private storage is not connected to this project.');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new CloudStoreError('WRITE_FAILED', 'Bot state exceeds the supported size. Archive the ledger before resuming.');
    try {
      const { put } = await import('@vercel/blob');
      const result = await put(path, text, {
        access: 'private', contentType: 'application/json', addRandomSuffix: false,
        allowOverwrite: !options.createOnly,
        ...(options.ifMatch ? { ifMatch: options.ifMatch } : {}),
        ...await authentication(),
        abortSignal: AbortSignal.timeout(8000),
      });
      return { etag: result.etag };
    } catch (error: any) {
      if (conflict(error)) throw new CloudStoreError('CONFLICT', 'The bot state changed concurrently.');
      if (options.createOnly) {
        // Some Blob versions report an existing pathname as a generic BlobError.
        // Check existence without exposing that raw error or ever overwriting it.
        const existing = await this.read(path).catch(() => null);
        if (existing) throw new CloudStoreError('CONFLICT', 'Bot state was initialized concurrently.');
      }
      if (error instanceof CloudStoreError) throw error;
      throw new CloudStoreError('WRITE_FAILED', 'Private storage could not be updated. Trading must remain paused.');
    }
  }
}

function defaultState(now: number): StoredState {
  return {
    schemaVersion: 1, revision: 0, updatedAt: now,
    config: { isPaperTrading: true, enableAutoTrade: false, maxTradeAmount: 1, maxDailyLoss: 5, minConfidence: 0.65, minEdge: 0.03, minPriceMovePct: 0.008, detectionWindowMs: 150, cooldownMs: 1000, maxTradesPerHour: 30, executionSlippage: 0.01, predictSyncIntervalMs: 1000, takeProfitPct: 0.04, stopLossPct: 0.08 },
    ledger: [], commands: [], status: { workerStatus: 'WAITING', heartbeatAt: null }, credentialRevision: 0,
  };
}

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Snapshots must never persist wallet/provider credentials or signed orders. */
function cleanJson<T>(value: T): T {
  const secrets = ['WALLET_PRIVATE_KEY', 'PREDICT_FUN_API_KEY', 'BOT_CONTROL_TOKEN', 'BLOB_READ_WRITE_TOKEN']
    .map(key => process.env[key]).filter((value): value is string => !!value && value.length >= 8);
  try {
    const encoded = JSON.stringify(value, (key, item) => {
      if (SENSITIVE_FIELDS.test(key)) return undefined;
      if (typeof item === 'string') {
        let safe = item;
        for (const secret of secrets) safe = safe.split(secret).join('[redacted]');
        return safe.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]');
      }
      return item;
    });
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error('size');
    return JSON.parse(encoded);
  } catch { throw new CloudStoreError('CORRUPT_STATE', 'Bot state contains unsupported or oversized data.'); }
}

function validateState(value: unknown): StoredState {
  if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      !Number.isFinite(value.updatedAt) || !object(value.config) || !Array.isArray(value.ledger) || !Array.isArray(value.commands) || !object(value.status)) {
    throw new CloudStoreError('CORRUPT_STATE', 'Stored bot state has an invalid schema. It must be recovered before trading.');
  }
  const allowedTopLevel = new Set(['schemaVersion', 'revision', 'updatedAt', 'config', 'ledger', 'commands', 'status', 'lease', 'sealedCredentials', 'credentialRevision']);
  if (Object.keys(value).some(key => !allowedTopLevel.has(key))) {
    throw new CloudStoreError('CORRUPT_STATE', 'Stored bot state contains unsupported fields. Plaintext credentials cannot be stored.');
  }
  const credentialRevision = value.credentialRevision ?? 0;
  if (!Number.isSafeInteger(credentialRevision) || credentialRevision < 0) throw new CloudStoreError('CORRUPT_STATE', 'Stored credential revision is invalid.');
  let sealedCredentials: SealedCredentials | undefined;
  if (value.sealedCredentials !== undefined) {
    try { sealedCredentials = validateSealedCredentials(value.sealedCredentials); }
    catch { throw new CloudStoreError('CORRUPT_STATE', 'Stored credentials must use the supported encrypted envelope.'); }
    if (credentialRevision < 1) throw new CloudStoreError('CORRUPT_STATE', 'Stored encrypted credentials have no revision.');
  }
  if (value.lease !== undefined && (!object(value.lease) || typeof value.lease.owner !== 'string' || !value.lease.owner || !Number.isFinite(value.lease.expiresAt) || !Number.isSafeInteger(value.lease.generation) || value.lease.generation < 1)) {
    throw new CloudStoreError('CORRUPT_STATE', 'Stored worker lease has an invalid schema.');
  }
  const ledgerIds = new Set<string>();
  for (const trade of value.ledger) {
    if (!object(trade) || typeof trade.id !== 'string' || !trade.id || ledgerIds.has(trade.id) ||
        !Number.isFinite(trade.timestamp) || trade.timestamp <= 0 || !Number.isFinite(trade.amount) || trade.amount < 0 ||
        !['paper', 'live', 'unknown'].includes(trade.mode) ||
        trade.resolvedAt !== undefined && (!Number.isFinite(trade.resolvedAt) || trade.resolvedAt <= 0) ||
        trade.pnl !== undefined && !Number.isFinite(trade.pnl) || trade.resolved === true && !Number.isFinite(trade.pnl) ||
        ['resolved', 'isSold', 'isCancelled', 'isFilled'].some(key => trade[key] !== undefined && typeof trade[key] !== 'boolean')) {
      throw new CloudStoreError('CORRUPT_STATE', 'Stored trade ledger has invalid or duplicate records. Recover it before trading.');
    }
    ledgerIds.add(trade.id);
  }
  for (const command of value.commands) {
    if (!object(command) || typeof command.id !== 'string' || !command.id || !['config', 'clearLogs'].includes(command.type) || !Number.isFinite(command.createdAt) ||
        command.payload !== undefined && !object(command.payload) || command.status !== undefined && !['pending', 'applied', 'failed'].includes(command.status)) {
      throw new CloudStoreError('CORRUPT_STATE', 'Stored bot commands have an invalid schema.');
    }
  }
  // Validate strategy types/ranges without confusing persisted desired mode with
  // this process's permission to execute live orders (the engine enforces that).
  const config = publicConfig(value.config as any) as Record<string, any>;
  if (config.isPaperTrading !== undefined && typeof config.isPaperTrading !== 'boolean') throw new CloudStoreError('CORRUPT_STATE', 'Stored trading mode is invalid.');
  try { validateControlConfig({ ...config, isPaperTrading: true }); }
  catch { throw new CloudStoreError('CORRUPT_STATE', 'Stored strategy settings are invalid.'); }
  // Opaque ciphertext must not pass through plaintext secret redaction. Restore
  // the exact validated envelope after cleaning the rest of the snapshot.
  const cleaned = cleanJson({ ...value, config, credentialRevision, sealedCredentials: undefined });
  if (sealedCredentials) cleaned.sealedCredentials = sealedCredentials;
  return cleaned as StoredState;
}

function publicState(value: StoredState): CloudState {
  const { lease: _lease, ...state } = value;
  return structuredClone(state);
}

/**
 * One document owns both state and lease. Their shared ETag makes ownership
 * fencing atomic: an old worker cannot write after another worker takes over.
 * A separate lease blob would leave a read-check/write race between documents.
 */
export class CloudStore {
  readonly pathname: string;
  private readonly now: () => number;

  constructor(private readonly adapter: BlobJsonAdapter = new VercelBlobJsonAdapter(), options: { prefix?: string; now?: () => number } = {}) {
    const prefix = options.prefix ?? process.env.BOT_CLOUD_PREFIX ?? process.env.BOT_STATE_NAMESPACE ?? 'predict-fun/v1';
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,160}$/.test(prefix) || prefix.includes('..')) throw new Error('Invalid bot storage namespace');
    this.pathname = `${prefix.replace(/\/$/, '')}/state.json`;
    this.now = options.now ?? Date.now;
  }

  private async readDocument(): Promise<{ value: StoredState; etag?: string }> {
    const record = await this.adapter.read(this.pathname);
    if (!record) return { value: defaultState(this.now()) };
    if (!record.etag || typeof record.etag !== 'string') throw new CloudStoreError('CORRUPT_STATE', 'Stored bot state has no version identifier.');
    return { value: validateState(record.value), etag: record.etag };
  }

  async readState(): Promise<CloudState> { return publicState((await this.readDocument()).value); }

  private requireOwner(state: StoredState, owner: string, minRemainingMs = 0): void {
    if (!state.lease || state.lease.owner !== owner || state.lease.expiresAt - this.now() <= minRemainingMs) {
      throw new CloudStoreError('LEASE_LOST', 'This worker no longer owns the trading lease.');
    }
  }

  private async update(mutator: (state: StoredState) => void | Promise<void>, owner?: string): Promise<StoredState> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await this.readDocument();
      if (owner) this.requireOwner(record.value, owner);
      const draft = structuredClone(record.value);
      await mutator(draft);
      if (owner) this.requireOwner(draft, owner);
      if ((draft.credentialRevision ?? 0) < (record.value.credentialRevision ?? 0)) throw new CloudStoreError('CORRUPT_STATE', 'Credential revisions cannot move backwards.');
      if (JSON.stringify(draft.sealedCredentials) !== JSON.stringify(record.value.sealedCredentials) && (draft.credentialRevision ?? 0) <= (record.value.credentialRevision ?? 0)) {
        throw new CloudStoreError('CORRUPT_STATE', 'Updating encrypted credentials requires a new credential revision.');
      }
      draft.revision = record.value.revision + 1;
      draft.updatedAt = this.now();
      const validated = validateState(draft);
      try {
        await this.adapter.write(this.pathname, validated, record.etag ? { ifMatch: record.etag } : { createOnly: true });
        return validated;
      } catch (error) {
        if (!conflict(error) && !(error instanceof CloudStoreError && error.code === 'CONFLICT')) throw error;
        if (attempt === 2) throw new CloudStoreError('CONFLICT', 'Bot state remains busy. No update was committed by this worker.');
      }
    }
    throw new CloudStoreError('CONFLICT', 'Bot state remains busy.');
  }

  async mutateState(mutator: (draft: CloudState) => void | Promise<void>, owner?: string): Promise<CloudState> {
    if (owner !== undefined) this.validateLeaseInput(owner, 45000);
    return publicState(await this.update(async stored => {
      const draft = publicState(stored);
      await mutator(draft);
      validateState(draft); // Reject unsupported plaintext credential fields, even on a mutation draft.
      stored.config = draft.config;
      stored.ledger = draft.ledger;
      stored.commands = draft.commands;
      stored.status = draft.status;
      stored.sealedCredentials = draft.sealedCredentials;
      stored.credentialRevision = draft.credentialRevision;
    }, owner));
  }

  async acquireLease(owner: string, ttlMs = 45000): Promise<boolean> {
    this.validateLeaseInput(owner, ttlMs);
    class LeaseBusy extends Error {}
    try {
      await this.update(state => {
        if (state.lease && state.lease.owner !== owner && state.lease.expiresAt > this.now()) throw new LeaseBusy();
        state.lease = { owner, expiresAt: this.now() + ttlMs, generation: (state.lease?.generation ?? 0) + (state.lease?.owner === owner ? 0 : 1) };
      });
      return true;
    } catch (error) { if (error instanceof LeaseBusy) return false; throw error; }
  }

  async renewLease(owner: string, ttlMs = 45000): Promise<void> {
    this.validateLeaseInput(owner, ttlMs);
    await this.update(state => { state.lease!.expiresAt = this.now() + ttlMs; }, owner);
  }

  /** Call directly before a live POST; short remaining leases fail closed. */
  async assertLease(owner: string, minRemainingMs = 10000): Promise<void> {
    if (!Number.isFinite(minRemainingMs) || minRemainingMs < 0) throw new Error('Invalid lease safety margin');
    this.requireOwner((await this.readDocument()).value, owner, minRemainingMs);
  }

  async releaseLease(owner: string): Promise<void> {
    await this.update(state => {
      if (state.lease?.owner === owner) delete state.lease;
    });
  }

  private validateLeaseInput(owner: string, ttlMs: number): void {
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid worker lease owner');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 15000 || ttlMs > 120000) throw new Error('Worker lease TTL must be between 15000 and 120000 ms');
  }
}
