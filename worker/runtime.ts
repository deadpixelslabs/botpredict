import { randomUUID } from 'node:crypto';
import type { ArbitrageConfig, ArbitrageTrade, EngineRuntimeOptions } from '../server/arbitrage-engine';
import { CloudStoreError, type CloudCommand, type CloudState } from '../server/cloudStore';
import { publicConfig, validateControlConfig } from '../server/controlConfig';
import { credentialProofId, credentialsFromEnvironment, unsealCredentials, type BotCredentials } from '../server/credentials';

const LEASE_MS = 45_000;
const RENEW_MS = 10_000;
const PUBLISH_MS = 2_000;
const SUBMIT_MARGIN_MS = 10_000;
const AUTH_PROOF_MS = 5 * 60_000;
const STORAGE_FAILURE_CODES = new Set(['READ_FAILED', 'WRITE_FAILED', 'LEASE_LOST', 'CONFLICT', 'CORRUPT_STATE', 'NOT_CONFIGURED']);
type WorkerFailureCode = CloudStoreError['code'] | 'WORKER_ERROR';

export interface WorkerStore {
  acquireLease(owner: string, ttlMs?: number): Promise<boolean>;
  renewLease(owner: string, ttlMs?: number): Promise<void>;
  assertLease(owner: string, minRemainingMs?: number): Promise<void>;
  readState(): Promise<CloudState>;
  mutateState(mutator: (state: CloudState) => void | Promise<void>, owner?: string): Promise<CloudState>;
  releaseLease(owner: string): Promise<void>;
}

export interface WorkerEngine {
  cfg: ArbitrageConfig;
  ready(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  setConfig(config: Partial<ArbitrageConfig>): void;
  clearLogs(): void;
  getStats(): Record<string, any>;
  trades?: readonly ArbitrageTrade[];
}

export interface WorkerOptions {
  store: WorkerStore | null;
  createEngine: (config: Partial<ArbitrageConfig>, runtime: EngineRuntimeOptions) => WorkerEngine;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  owner?: string;
  log?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  resolveCredentials?: (state: CloudState, env: NodeJS.ProcessEnv) => BotCredentials | Promise<BotCredentials>;
  applyCredentials?: (credentials: BotCredentials) => void | Promise<void>;
  verifyCredentials?: (credentials: BotCredentials) => Promise<void>;
}

/** No timers or network are created until step()/run() is called. */
export class WorkerRuntime {
  readonly owner: string;
  phase = 'starting';
  faulted = false;
  lastFailureCode: WorkerFailureCode | null = null;
  lastFailureAt: number | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private active = false;
  private stopping = false;
  private tickBusy = false;
  private tickDone: Promise<void> = Promise.resolve();
  private tickResolve: (() => void) | null = null;
  private configurationApplied = false;
  private ledgerDurable = false;
  private leaseDeadline = 0;
  private lastRenew = 0;
  private lastPublish = -Infinity;
  private engine: WorkerEngine | null = null;
  private engineStarted = false;
  private engineGeneration = 0;
  private stopPromise: Promise<void> | null = null;
  private readonly initialCredentialEnv: NodeJS.ProcessEnv;
  private credentials: BotCredentials = emptyCredentials();
  private credentialsRevisionApplied = -1;
  private desiredCredentialRevision = 0;
  private credentialsPending = false;
  private credentialLoadFailed = false;
  private credentialRecoveryBlocked = false;
  private attemptedCredentialRevision = -1;
  private lastCredentialAttempt = -Infinity;
  private predictAuthenticated = false;
  private authenticatedAt: number | null = null;
  private lastAuthAttempt = -Infinity;

  constructor(private readonly options: WorkerOptions) {
    this.owner = options.owner ?? randomUUID();
    this.env = options.env ?? process.env;
    this.initialCredentialEnv = {PREDICT_FUN_API_KEY:this.env.PREDICT_FUN_API_KEY,WALLET_PRIVATE_KEY:this.env.WALLET_PRIVATE_KEY,PREDICT_ACCOUNT_ADDRESS:this.env.PREDICT_ACCOUNT_ADDRESS};
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (message => console.log(message));
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  }

  canExecute = (): boolean => this.active && !this.stopping && !this.faulted &&
    this.configurationApplied && this.ledgerDurable && this.engineStarted &&
    !this.offline() && !!this.credentials.predictFunApiKey && !this.credentialsPending &&
    this.credentialsRevisionApplied === this.desiredCredentialRevision &&
    (this.engine?.cfg.isPaperTrading !== false || this.authenticated()) &&
    this.leaseDeadline - this.now() > SUBMIT_MARGIN_MS;

  private effectiveEnv(): NodeJS.ProcessEnv {
    return {...this.env,PREDICT_FUN_API_KEY:this.credentials.predictFunApiKey,WALLET_PRIVATE_KEY:this.credentials.walletPrivateKey,
      PREDICT_ACCOUNT_ADDRESS:this.credentials.predictAccountAddress,WALLET_ADDRESS:this.credentials.walletAddress};
  }

  private authenticated(): boolean {
    return this.predictAuthenticated && this.authenticatedAt !== null && this.now() - this.authenticatedAt < AUTH_PROOF_MS &&
      !this.credentialsPending && this.credentialsRevisionApplied === this.desiredCredentialRevision;
  }

  private offline(): boolean { return this.env.BOOT_OFFLINE === 'true' || this.env.BOT_OFFLINE === 'true'; }

  private setPhase(phase: string): void {
    if (this.phase === phase) return;
    this.phase = phase;
    // Only fixed operational labels are logged. Never log provider errors or environment data.
    this.log(`[Worker] ${phase}`);
  }

  private recordFailure(error: unknown): void {
    // A shutdown write may fail after the original error. Preserve the first
    // cause and never persist or log arbitrary provider messages or codes.
    if (this.lastFailureCode !== null) return;
    this.lastFailureCode = error instanceof CloudStoreError && STORAGE_FAILURE_CODES.has(error.code) ? error.code : 'WORKER_ERROR';
    this.lastFailureAt = this.now();
    this.log(`[Worker] failure: ${this.lastFailureCode}`);
  }

  /** Engine invokes this after its intent has been committed, immediately before each live POST. */
  private beforeSubmit = async (action: 'BUY' | 'SELL' = 'BUY'): Promise<void> => {
    if (!this.canExecute() || !this.options.store) throw new Error('Worker is not ready to submit an order');
    let state: CloudState;
    try {
      await this.options.store.assertLease(this.owner, SUBMIT_MARGIN_MS);
      state = await this.options.store.readState();
    } catch (error) {
      this.recordFailure(error);
      this.faulted = true;
      this.configurationApplied = false;
      this.setPhase('failed');
      throw new Error('Order submission paused until worker state is confirmed');
    }
    if ((state.credentialRevision ?? 0) !== this.credentialsRevisionApplied) {
      this.desiredCredentialRevision = state.credentialRevision ?? 0;
      this.credentialsPending = true;
      this.predictAuthenticated = false;
      this.configurationApplied = false;
      throw new Error('Order submission paused while credentials are changing');
    }
    if (state.commands.some(command => pending(command) && command.type === 'config')) {
      this.configurationApplied = false;
      throw new Error('A configuration command is waiting to be applied');
    }
    if (action === 'BUY' && (state.config.isPaperTrading !== false || state.config.enableAutoTrade !== true)) {
      throw new Error('Live entry is paused by the current server configuration');
    }
    if (!this.canExecute()) throw new Error('Worker lease no longer permits submission');
  };

  async step(): Promise<void> {
    if (this.stopping || this.faulted || this.tickBusy) return;
    this.tickBusy = true;
    this.tickDone = new Promise(resolve => { this.tickResolve = resolve; });
    try {
      const store = this.options.store;
      if (!store) { this.setPhase('waiting_for_storage'); return; }
      if (!this.active) {
        const began = this.now();
        if (!await store.acquireLease(this.owner, LEASE_MS)) { this.setPhase('standby'); return; }
        this.active = true;
        // The call's start time is conservative when network latency is nonzero.
        this.leaseDeadline = began + LEASE_MS;
        this.lastRenew = began;
      }
      if (this.now() - this.lastRenew >= RENEW_MS) {
        const began = this.now();
        await store.renewLease(this.owner, LEASE_MS);
        this.leaseDeadline = began + LEASE_MS;
        this.lastRenew = began;
      }
      let state = await store.readState();
      if (this.stopping) return;
      this.desiredCredentialRevision = state.credentialRevision ?? 0;
      if (!await this.prepareCredentials(state)) {
        this.setPhase(this.credentialRecoveryBlocked ? 'waiting_for_reconciliation' : this.credentialsPending ? 'waiting_for_open_positions' : 'waiting_for_auth');
        if (this.now() - this.lastPublish >= PUBLISH_MS) await this.publish();
        return;
      }
      if (!this.engine) await this.initializeEngine(state);
      if (this.stopping) return;
      await this.verifyAuth();
      await this.applyCommands(state.commands);
      // A concurrent API enqueue is retained by CAS. Pause entries until a later tick applies it.
      state = await store.readState();
      this.desiredCredentialRevision = state.credentialRevision ?? 0;
      if (this.desiredCredentialRevision !== this.credentialsRevisionApplied) {
        this.credentialsPending = true;
        this.predictAuthenticated = false;
        this.configurationApplied = false;
      }
      this.configurationApplied = this.configurationApplied && !state.commands.some(command => pending(command) && command.type === 'config');
      if (this.stopping) return;
      if (!this.engine) throw new Error('Engine initialization did not complete');
      if (this.offline()) this.setPhase('offline');
      else if (this.credentialsPending) this.setPhase('waiting_for_open_positions');
      else if (this.credentialLoadFailed || this.engine.cfg.isPaperTrading === false && !this.authenticated()) this.setPhase('waiting_for_auth');
      else if (!this.credentials.predictFunApiKey) this.setPhase('waiting_for_api_key');
      else if (!this.configurationApplied) this.setPhase('waiting_for_configuration');
      else {
        if (!this.engineStarted) {
          // Engine.start() may open feeds but cannot enter until it has returned and the gate opens.
          await this.engine.start();
          this.engineStarted = true;
          if (this.stopping) return;
        }
        this.setPhase(this.engine.cfg.enableAutoTrade ? 'running' : 'paused');
      }
      if (this.now() - this.lastPublish >= PUBLISH_MS) await this.publish();
    } catch (error) {
      await this.failClosed(error);
    } finally {
      this.tickBusy = false;
      this.tickResolve?.();
      this.tickResolve = null;
    }
  }

  private async initializeEngine(state: CloudState): Promise<void> {
    const store = this.options.store!;
    let config: Partial<ArbitrageConfig>;
    try {
      config = validateControlConfig({ ...state.config }, this.effectiveEnv());
      this.configurationApplied = true;
    } catch {
      // Missing live setup must not block a later command returning the bot to paper/paused.
      config = validateControlConfig({ ...state.config, isPaperTrading: true, enableAutoTrade: false }, this.effectiveEnv());
      this.configurationApplied = false;
    }
    const generation = ++this.engineGeneration;
    const credentialRevision = this.credentialsRevisionApplied;
    this.engine = this.options.createEngine({...config,predictFunApiKey:this.credentials.predictFunApiKey}, {
      loadTrades: async () => {
        await store.assertLease(this.owner, SUBMIT_MARGIN_MS);
        const current = await store.readState();
        this.ledgerDurable = true;
        return structuredClone(current.ledger) as ArbitrageTrade[];
      },
      saveTrades: async trades => {
        if (generation !== this.engineGeneration) throw new Error('A previous engine cannot replace the active ledger');
        // Leave existing API commands and applied settings untouched.
        this.ledgerDurable = false;
        try {
          const snapshot = structuredClone(trades);
          await store.mutateState(draft => { draft.ledger = snapshot; }, this.owner);
          this.ledgerDurable = true;
        } catch (error) {
          this.recordFailure(error);
          this.configurationApplied = false;
          this.faulted = true;
          this.setPhase('failed');
          throw new Error('Durable order ledger could not be committed');
        }
      },
      beforeSubmit: async action => {
        if (generation !== this.engineGeneration || credentialRevision !== this.credentialsRevisionApplied) throw new Error('A previous engine cannot submit orders');
        await this.beforeSubmit(action);
      },
      canExecute: () => generation === this.engineGeneration && credentialRevision === this.credentialsRevisionApplied && this.canExecute(),
    });
    await this.engine.ready();
  }

  private async prepareCredentials(state: CloudState): Promise<boolean> {
    if (this.credentialsRevisionApplied === this.desiredCredentialRevision && !this.credentialLoadFailed) return true;
    if (this.engine && (!this.ledgerDurable || hasOpenLive(state.ledger) || hasOpenLive(this.engine.trades ?? []))) {
      this.credentialsPending = true;
      this.predictAuthenticated = false;
      this.configurationApplied = false;
      return false;
    }
    if ((this.credentialLoadFailed || this.credentialRecoveryBlocked) && this.attemptedCredentialRevision === this.desiredCredentialRevision && this.now() - this.lastCredentialAttempt < RENEW_MS) return false;
    this.lastCredentialAttempt = this.now();
    this.attemptedCredentialRevision = this.desiredCredentialRevision;
    this.configurationApplied = false;
    this.predictAuthenticated = false;
    this.authenticatedAt = null;
    this.lastAuthAttempt = -Infinity;
    this.engineStarted = false;
    // stop() drains in-flight SDK calls and persistence before another signer is installed.
    if (this.engine) { await this.engine.stop(); this.engine = null; }
    try {
      const credentials = this.options.resolveCredentials
        ? await this.options.resolveCredentials(state, this.env)
        : state.sealedCredentials ? unsealCredentials(state.sealedCredentials, this.env)
          : credentialsFromEnvironment(this.initialCredentialEnv) ?? {...emptyCredentials(),predictFunApiKey:this.initialCredentialEnv.PREDICT_FUN_API_KEY?.trim() ?? ''};
      const executionAccount = (credentials.predictAccountAddress || credentials.walletAddress).toLowerCase();
      const signerAddress = credentials.walletAddress.toLowerCase();
      if (state.ledger.some(trade => trade.mode === 'live' && !trade.resolved &&
          (typeof trade.executionAccount !== 'string' || trade.executionAccount.toLowerCase() !== executionAccount ||
           typeof trade.signerAddress !== 'string' || trade.signerAddress.toLowerCase() !== signerAddress))) {
        this.credentialRecoveryBlocked = true;
        this.credentialLoadFailed = false;
        this.credentialsPending = false;
        return false;
      }
      await this.options.applyCredentials?.(credentials);
      this.credentials = credentials;
      this.credentialsRevisionApplied = this.desiredCredentialRevision;
      this.credentialsPending = false;
      this.credentialLoadFailed = false;
      this.credentialRecoveryBlocked = false;
      return true;
    } catch {
      // An invalid encrypted bundle is authoritative: never fall back to the old environment wallet.
      this.credentials = emptyCredentials();
      this.credentialLoadFailed = true;
      this.credentialRecoveryBlocked = false;
      this.credentialsPending = false;
      return false;
    }
  }

  private async verifyAuth(): Promise<void> {
    if (this.offline() || !this.credentials.predictFunApiKey || !this.credentials.walletPrivateKey || !this.options.verifyCredentials) return;
    const delay = this.authenticated() ? AUTH_PROOF_MS - 30_000 : RENEW_MS;
    if (this.now() - this.lastAuthAttempt < delay) return;
    this.lastAuthAttempt = this.now();
    this.predictAuthenticated = false;
    this.authenticatedAt = null;
    try {
      await this.options.verifyCredentials(this.credentials);
      if (this.stopping || this.credentialsPending) return;
      this.predictAuthenticated = true;
      this.authenticatedAt = this.now();
    } catch { /* Auth failure is displayed without raw API/provider messages. */ }
  }

  private async applyCommands(commands: readonly CloudCommand[]): Promise<void> {
    if (!this.engine || !this.options.store) return;
    for (const command of commands) {
      if (!pending(command) || this.stopping) continue;
      const current = await this.options.store.readState();
      if ((current.credentialRevision ?? 0) !== this.credentialsRevisionApplied) {
        this.desiredCredentialRevision = current.credentialRevision ?? 0;
        this.credentialsPending = true;
        this.predictAuthenticated = false;
        this.configurationApplied = false;
        return;
      }
      const authoritative = current.commands.find(item => item.id === command.id);
      if (!authoritative || !pending(authoritative)) continue;
      const wasApplied = this.configurationApplied;
      this.configurationApplied = false;
      let applied = false;
      try {
        if (command.type === 'config') {
          const changes = validateControlConfig(authoritative.payload ?? {}, this.effectiveEnv());
          // Validate the merged mode too: an empty patch cannot bypass live prerequisites.
          const merged = {...publicConfig(this.engine.cfg),...changes};
          validateControlConfig(merged, this.effectiveEnv());
          if (merged.isPaperTrading === false && !this.authenticated()) throw new Error('Predict authentication is not confirmed');
          this.engine.setConfig(changes);
        } else if (command.type === 'clearLogs') this.engine.clearLogs();
        applied = true;
      } catch { /* Persist only a generic rejection, never engine/provider details. */ }
      const config = applied && command.type === 'config' ? publicConfig(this.engine.cfg) : undefined;
      let acknowledged = false;
      const committed = await this.options.store.mutateState(draft => {
        acknowledged = false;
        if ((draft.credentialRevision ?? 0) !== this.credentialsRevisionApplied) return;
        const stored = draft.commands.find(item => item.id === command.id);
        if (!stored || !pending(stored)) return;
        acknowledged = true;
        stored.status = applied ? 'applied' : 'failed';
        stored.appliedAt = this.now();
        if (!applied) stored.error = 'Command could not be applied. Check trading mode, open positions, and server setup.';
        else delete stored.error;
        if (config) draft.config = { ...config };
        draft.commands = retainCommands(draft.commands);
      }, this.owner);
      if (!acknowledged || (committed.credentialRevision ?? 0) !== this.credentialsRevisionApplied) {
        this.desiredCredentialRevision = committed.credentialRevision ?? 0;
        this.credentialsPending = this.desiredCredentialRevision !== this.credentialsRevisionApplied;
        this.configurationApplied = false;
        return;
      }
      this.configurationApplied = command.type === 'config' && applied ? true : wasApplied;
    }
  }

  private async publish(): Promise<void> {
    if (!this.options.store || !this.active) return;
    let authCredentialProofId: string | null = null;
    if (this.authenticated()) {
      try { authCredentialProofId = credentialProofId(this.credentials, this.env); } catch { /* No identity proof can be claimed without the server key. */ }
    }
    const status = {
      ...(this.engine?.getStats() ?? {}), heartbeatAt: this.now(), workerId: this.owner, phase: this.phase,
      workerStatus: this.phase.toUpperCase(),
      failureCode: this.lastFailureCode,
      failedAt: this.lastFailureAt,
      authenticatedAt: this.authenticatedAt,
      authCredentialProofId,
      credentialsRevisionApplied: this.credentialsRevisionApplied,
      liveAccountAddress: this.credentials.predictAccountAddress || this.credentials.walletAddress || null,
      readiness: {
        storage: true, predictApiKey: !!this.credentials.predictFunApiKey,
        engine: this.engineStarted, configuration: this.configurationApplied,
        lease: this.leaseDeadline - this.now() > SUBMIT_MARGIN_MS,
        predictAuthenticated: this.authenticated(),
        walletCryptoValid: !!this.credentials.walletPrivateKey && !!this.credentials.walletAddress,
        credentialIdentityMatches: !this.credentialRecoveryBlocked,
        liveCredentials: !!this.credentials.walletPrivateKey && !!this.credentials.predictFunApiKey &&
          this.env.ENABLE_LIVE_TRADING === 'true' && (this.env.BOT_CONTROL_TOKEN?.length ?? 0) >= 24,
      },
    };
    await this.options.store.mutateState(draft => { draft.status = status; }, this.owner);
    this.lastPublish = this.now();
  }

  private async failClosed(error: unknown): Promise<void> {
    this.faulted = true;
    this.configurationApplied = false;
    this.ledgerDurable = false;
    this.engineStarted = false;
    this.predictAuthenticated = false;
    this.recordFailure(error);
    this.setPhase('failed');
    if (this.engine) {
      try { this.engine.setConfig({ enableAutoTrade: false }); } catch {}
      try { await this.engine.stop(); } catch {}
    }
    // Best effort only: the same owner CAS that protects ledger writes must
    // also protect failure diagnostics after an expired lease or takeover.
    try { await this.publish(); } catch {}
    this.active = false;
    this.leaseDeadline = 0;
    // If ownership moved, releaseLease cannot remove the new owner's lease.
    try { await this.options.store?.releaseLease(this.owner); } catch {}
  }

  async run(): Promise<void> {
    while (!this.stopping && !this.faulted) {
      await this.step();
      if (!this.stopping && !this.faulted) await this.sleep(this.phase === 'waiting_for_storage' || this.phase === 'standby' ? 10_000 : 1_000);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.configurationApplied = false;
    this.stopPromise = (async () => {
      await this.tickDone;
      try { if (this.engine) await this.engine.stop(); } catch {}
      if (this.active && this.options.store) {
        this.setPhase(this.faulted ? 'failed' : 'stopped');
        try { await this.publish(); } catch {}
        try { await this.options.store.releaseLease(this.owner); } catch {}
      }
      this.active = false;
      this.leaseDeadline = 0;
    })();
    return this.stopPromise;
  }
}

function pending(command: CloudCommand): boolean { return command.status === undefined || command.status === 'pending'; }
function emptyCredentials(): BotCredentials { return {predictFunApiKey:'',walletPrivateKey:'',predictAccountAddress:'',walletAddress:''}; }
function hasOpenLive(ledger: readonly any[]): boolean { return ledger.some(trade => trade.mode === 'live' && !trade.resolved); }
function retainCommands(commands: CloudCommand[]): CloudCommand[] {
  const finished = commands.filter(command => !pending(command)).slice(-50);
  const retained = new Set(finished.map(command => command.id));
  return commands.filter(command => pending(command) || retained.has(command.id));
}
