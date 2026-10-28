import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { CloudStore, cloudStorageConfigured } from './cloudStore';
import type { CloudState } from './cloudStore';
import { publicConfig, sameOriginRequest, validControlToken, validateControlConfig } from './controlConfig';
import { credentialProofId, credentialsFromEnvironment, getSecretStatus, sealCredentials, unsealCredentials, validateCredentials } from './credentials';

export interface CloudApiStore {
  readState(): Promise<CloudState>;
  mutateState(mutator: (draft: CloudState) => void | Promise<void>): Promise<CloudState>;
}
export interface CloudApiOptions {
  store?: CloudApiStore;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const QUEUE_LIMIT = 20;
const HEARTBEAT_LIMIT_MS = 30000;

function setupFlags(env: NodeJS.ProcessEnv) {
  return {
    storageConfigured: cloudStorageConfigured(env),
    operatorConfigured: (env.BOT_CONTROL_TOKEN?.length || 0) >= 24,
    predictApiConfigured: Boolean(env.PREDICT_FUN_API_KEY),
    walletConfigured: Boolean(env.WALLET_PRIVATE_KEY && (env.PREDICT_ACCOUNT_ADDRESS || env.WALLET_ADDRESS)),
    liveTradingEnabled: env.ENABLE_LIVE_TRADING === 'true',
  };
}

function credentialContext(state: CloudState, env: NodeJS.ProcessEnv) {
  const revision = Number.isSafeInteger(state.credentialRevision) ? state.credentialRevision! : 0;
  const stored = Boolean(state.sealedCredentials);
  let credentials: ReturnType<typeof unsealCredentials> | null = null;
  let readable = true;
  try { credentials = stored ? unsealCredentials(state.sealedCredentials!,env) : credentialsFromEnvironment(env); }
  catch { readable = false; }
  let proofId:string|null = null;
  if (credentials) { try { proofId = credentialProofId(credentials,env); } catch { readable = false; credentials = null; } }
  const secretStatus = getSecretStatus(credentials);
  // An environment API key alone remains sufficient for paper market data.
  const paperApiConfigured = !stored && readable && Boolean(env.PREDICT_FUN_API_KEY);
  const flags = {
    ...setupFlags(env),
    predictApiConfigured: secretStatus.predictFunApiKeyConfigured || paperApiConfigured,
    walletConfigured: secretStatus.walletPrivateKeyConfigured,
    ...secretStatus,
    predictFunApiKeyConfigured: secretStatus.predictFunApiKeyConfigured || paperApiConfigured,
    credentialRevision: revision,
    credentialsStored: stored,
    credentialSource: stored ? 'stored' : env.PREDICT_FUN_API_KEY || env.WALLET_PRIVATE_KEY ? 'environment' : 'none',
    credentialValidation: !readable ? 'unreadable' : credentials ? 'format_valid' : 'missing',
    credentialsStatusAvailable: true,
  };
  const resolvedEnv = {...env};
  if (stored) {
    // Never fall back to a different environment wallet if saved credentials cannot be decrypted.
    delete resolvedEnv.PREDICT_FUN_API_KEY; delete resolvedEnv.WALLET_PRIVATE_KEY; delete resolvedEnv.PREDICT_ACCOUNT_ADDRESS; delete resolvedEnv.WALLET_ADDRESS;
  }
  if (credentials) {
    resolvedEnv.PREDICT_FUN_API_KEY = credentials.predictFunApiKey;
    resolvedEnv.WALLET_PRIVATE_KEY = credentials.walletPrivateKey;
    resolvedEnv.PREDICT_ACCOUNT_ADDRESS = credentials.predictAccountAddress || '';
    resolvedEnv.WALLET_ADDRESS = credentials.walletAddress;
  }
  return {flags,resolvedEnv,proofId};
}

// Cache public booleans/address only. Never retain decrypted keys in the API cache.
const credentialStatusCache = new Map<string, {flags:ReturnType<typeof credentialContext>['flags'];proofId:string|null}>();
function publicCredentialFlags(state: CloudState, env: NodeJS.ProcessEnv) {
  const identity = createHash('sha256').update(JSON.stringify({revision:state.credentialRevision || 0,sealed:state.sealedCredentials,environment:[env.BOT_CREDENTIALS_KEY,env.BOT_CONTROL_TOKEN,env.PREDICT_FUN_API_KEY,env.WALLET_PRIVATE_KEY,env.PREDICT_ACCOUNT_ADDRESS,env.WALLET_ADDRESS]})).digest('hex');
  const cached = credentialStatusCache.get(identity);
  if (cached) return {flags:{...cached.flags},proofId:cached.proofId};
  const context = credentialContext(state,env);
  const value = {flags:{...context.flags},proofId:context.proofId};
  credentialStatusCache.set(identity,value);
  if (credentialStatusCache.size > 16) credentialStatusCache.delete(credentialStatusCache.keys().next().value!);
  return value;
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function modeTrades(state: CloudState) {
  const mode = state.config.isPaperTrading === false ? 'live' : 'paper';
  return state.ledger.filter(t => t?.mode === mode);
}
function workerState(state: CloudState, now: number) {
  const status = state.status || {};
  const heartbeat = finite(status.heartbeatAt) ? status.heartbeatAt : null;
  const age = heartbeat === null ? null : now - heartbeat;
  const available = age !== null && age >= -1000 && age <= HEARTBEAT_LIMIT_MS;
  return {
    workerAvailable: available,
    workerHeartbeatAt: heartbeat,
    workerAgeMs: age,
    workerPhase: available ? String(status.phase || 'waiting') : 'offline',
    workerMessage: available && typeof status.message === 'string' ? status.message.slice(0, 240) : 'Daemon belum aktif atau heartbeat terakhir sudah kedaluwarsa.',
  };
}
function safeText(value: unknown, env: NodeJS.ProcessEnv, max = 1200): string {
  let text = typeof value === 'string' ? value : '';
  for (const [key, secret] of Object.entries(env)) {
    if (/(?:TOKEN|SECRET|PRIVATE_KEY|API_KEY)/.test(key) && secret && secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  return text.slice(0, max);
}
function publicTrade(trade: any, env: NodeJS.ProcessEnv) {
  const fields = ['id','timestamp','resolvedAt','mode','direction','amount','entryOdds','fairOdds','edge','outcome','pnl','pnlIsEstimate','targetLockTime','lockPrice','closePrice','sharesQuantity','entryBtcPrice','entryBid','isSold','sellPrice','isFilled','fillTimestamp','isCancelled','cancelledAt','submissionUncertain','reconciliationRequired','orderHash','orderId','sellOrderHash','sellOrderId','soldProceeds'];
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const value = trade[key];
    if (typeof value === 'string') result[key] = safeText(value, env, 300);
    else if (typeof value === 'boolean' || finite(value)) result[key] = value;
  }
  if (trade.signal && typeof trade.signal === 'object') result.signal = { reason: safeText(trade.signal.reason, env, 600), confidence: finite(trade.signal.confidence) ? trade.signal.confidence : undefined };
  return result;
}
function publicCommands(state: CloudState, env: NodeJS.ProcessEnv) {
  return state.commands.slice(-30).map(command => ({
    id: command.id, type: command.type, createdAt: command.createdAt,
    status: command.status || 'pending', error: command.error ? safeText(command.error, env, 240) : undefined,
  }));
}

export function cloudSnapshot(state: CloudState, env: NodeJS.ProcessEnv, now: number) {
  const status = state.status || {};
  const worker = workerState(state, now);
  const publicCredentials = publicCredentialFlags(state,env);
  const flags = publicCredentials.flags;
  const trades = modeTrades(state);
  const completed = trades.filter(t => t.resolved === true && t.isFilled === true && !t.isCancelled && !t.submissionUncertain && !t.reconciliationRequired && finite(t.pnl));
  const wins = completed.filter(t => t.pnl > 0).length;
  const losses = completed.filter(t => t.pnl < 0).length;
  const day = new Date(now);
  const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const daily = completed.filter(t => finite(t.resolvedAt) && t.resolvedAt >= dayStart && t.resolvedAt <= now);
  const quoteAge = finite(status.quoteAgeMs) && worker.workerAgeMs !== null ? Math.max(0, status.quoteAgeMs + worker.workerAgeMs) : null;
  const freshQuote = worker.workerAvailable && quoteAge !== null && quoteAge <= 2500;
  const credentialsApplied = status.credentialsRevisionApplied === flags.credentialRevision;
  const accountMatches = typeof flags.walletAddress === 'string' && typeof status.liveAccountAddress === 'string' && flags.walletAddress.toLowerCase() === status.liveAccountAddress.toLowerCase();
  const authenticated = accountMatches && worker.workerAvailable && credentialsApplied && publicCredentials.proofId !== null && status.authCredentialProofId === publicCredentials.proofId && status.readiness?.predictAuthenticated === true && finite(status.authenticatedAt) && now - status.authenticatedAt <= 300000 && now - status.authenticatedAt >= -1000;
  const balanceObservedAt = finite(status.walletBalanceObservedAt) ? status.walletBalanceObservedAt : null;
  const balanceFresh = worker.workerAvailable && flags.walletConfigured && balanceObservedAt !== null && now - balanceObservedAt >= -1000 && now - balanceObservedAt <= 45000 && finite(status.walletBalanceUsdt);
  const balanceReady = balanceFresh && finite(state.config.maxTradeAmount) && status.walletBalanceUsdt >= state.config.maxTradeAmount * 1.02;
  const liveOnline = balanceReady && status.storageHealthy !== false && status.readiness?.lease === true && worker.workerAvailable && freshQuote && state.config.isPaperTrading === false && state.config.enableAutoTrade === true && status.phase === 'running' && status.readiness?.engine === true && authenticated && flags.liveTradingEnabled && flags.predictApiConfigured && flags.walletConfigured;
  return {
    ...worker, ...flags,
    serverTime: now, snapshotAt: state.updatedAt,
    isPaperTrading: state.config.isPaperTrading !== false,
    enableAutoTrade: state.config.enableAutoTrade === true,
    tradingActive: state.config.isPaperTrading === false ? liveOnline : worker.workerAvailable && status.phase === 'running' && state.config.enableAutoTrade === true,
    liveOnline,
    walletBalanceReady: balanceReady,
    walletBalanceFresh: balanceFresh,
    walletBalanceObservedAt: balanceObservedAt,
    predictAuthenticated: authenticated,
    authenticatedAt: authenticated ? status.authenticatedAt : null,
    credentialsRevisionApplied: Number.isSafeInteger(status.credentialsRevisionApplied) ? status.credentialsRevisionApplied : null,
    liveAccountAddress: /^0x[0-9a-fA-F]{40}$/.test(status.liveAccountAddress || '') ? status.liveAccountAddress : null,
    currentPrice: worker.workerAvailable && finite(status.currentPrice) && status.currentPrice > 0 ? status.currentPrice : null,
    walletBalanceUsdt: state.config.isPaperTrading === false && balanceFresh ? status.walletBalanceUsdt : null,
    storageHealthy: status.storageHealthy !== false,
    quoteAgeMs: quoteAge,
    quoteSource: freshQuote && typeof status.quoteSource === 'string' ? status.quoteSource : null,
    lastPredictOdds: freshQuote && status.lastPredictOdds && finite(status.lastPredictOdds.upOdds) && status.lastPredictOdds.upOdds > 1 && finite(status.lastPredictOdds.downOdds) && status.lastPredictOdds.downOdds > 1 ? {
      upOdds: status.lastPredictOdds.upOdds, downOdds: status.lastPredictOdds.downOdds, timestamp: status.lastPredictOdds.timestamp,
    } : null,
    dailyPnl: daily.reduce((sum, trade) => sum + trade.pnl, 0),
    totalPnl: completed.reduce((sum, trade) => sum + trade.pnl, 0),
    totalTrades: trades.length, wins, losses,
    winRate: wins + losses ? (wins / (wins + losses) * 100).toFixed(1) : null,
    pnlIsEstimate: completed.some(t => t.pnlIsEstimate !== false),
    tradesThisHour: trades.filter(t => finite(t.timestamp) && t.timestamp > now - 3600000 && t.timestamp <= now).length,
    activeTrades: trades.filter(t => !t.resolved && !t.isSold && !t.isCancelled).length,
    reconciliationRequired: trades.some(t => !t.resolved && (t.submissionUncertain || t.reconciliationRequired)),
    epochSecond: Math.floor(now / 1000) % 300,
    logs: worker.workerAvailable && Array.isArray(status.logs) ? status.logs.slice(-150).map((line: unknown) => safeText(line, env)) : [],
    commands: publicCommands(state, env),
    recentTrades: trades.slice().sort((a,b) => b.timestamp - a.timestamp).slice(0,25).map(t => publicTrade(t,env)),
  };
}

/** Vercel Functions own bounded HTTP requests only. They never import or start the engine. */
export function createCloudApi(options: CloudApiOptions = {}) {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  let store = options.store;
  const getStore = () => store ||= new CloudStore();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((_req,res,next) => { res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); next(); });
  app.get('/api/health', (_req,res) => res.json({ok:true,service:'predict-dashboard',...setupFlags(env),credentialsStatusAvailable:false,serverTime:now()}));
  app.use('/api', (req,res,next) => {
    if (!setupFlags(env).operatorConfigured) { res.status(503).json({error:'Konfigurasikan BOT_CONTROL_TOKEN minimal 24 karakter di Vercel Environment Variables.',code:'OPERATOR_NOT_CONFIGURED'}); return; }
    if (!validControlToken(req.get('authorization'), env.BOT_CONTROL_TOKEN)) { res.status(401).json({error:'Token operator tidak valid.',code:'UNAUTHORIZED'}); return; }
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && !sameOriginRequest(req.get('origin'),req.get('host'))) { res.status(403).json({error:'Permintaan kontrol lintas origin ditolak.',code:'ORIGIN_REJECTED'}); return; }
    if (!setupFlags(env).storageConfigured) { res.status(503).json({error:'Hubungkan private Vercel Blob store sebelum memakai dashboard.',code:'STORAGE_NOT_CONFIGURED'}); return; }
    next();
  });
  const read = async (res: express.Response, action:(state:CloudState)=>void) => {
    try { action(await getStore().readState()); }
    catch { res.status(503).json({error:'Penyimpanan bot belum dapat dibaca. Entry bot tetap ditahan.',code:'STORAGE_UNAVAILABLE'}); }
  };
  app.get('/api/config', (_req,res) => read(res,state => {
    const credentials = credentialContext(state,env);
    res.json({...publicConfig(state.config as any),...credentials.flags,controlTokenRequired:true,commands:publicCommands(state,credentials.resolvedEnv),...workerState(state,now())});
  }));
  app.get('/api/credentials', (_req,res) => read(res,state => res.json(credentialContext(state,env).flags)));
  app.post('/api/credentials', async (req,res) => {
    const allowed = ['PREDICT_FUN_API_KEY','WALLET_PRIVATE_KEY','PREDICT_ACCOUNT_ADDRESS'];
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== allowed.length || !allowed.every(key => Object.hasOwn(body,key) && typeof body[key] === 'string')) {
      res.status(400).json({error:'Isi tepat tiga kolom kredensial. Gunakan account address kosong untuk EOA.',code:'INVALID_CREDENTIALS'}); return;
    }
    let sealed: ReturnType<typeof sealCredentials>;
    try {
      const credentials = validateCredentials({predictFunApiKey:body.PREDICT_FUN_API_KEY,walletPrivateKey:body.WALLET_PRIVATE_KEY,predictAccountAddress:body.PREDICT_ACCOUNT_ADDRESS});
      sealed = sealCredentials(credentials,env);
    } catch { res.status(400).json({error:'Format kredensial atau konfigurasi enkripsi tidak valid. Tidak ada key yang disimpan.',code:'INVALID_CREDENTIALS'}); return; }
    try {
      const state = await getStore().mutateState(draft => {
        if (draft.ledger.some(trade => trade?.mode === 'live' && trade.resolved !== true && trade.isSold !== true)) throw new Error('OPEN_LIVE_POSITIONS');
        draft.sealedCredentials = sealed;
        draft.credentialRevision = (Number.isSafeInteger(draft.credentialRevision) ? draft.credentialRevision! : 0) + 1;
        draft.config.enableAutoTrade = false;
        // An older queued live command must not silently activate newly replaced credentials.
        draft.commands = draft.commands.map(command => (!command.status || command.status === 'pending') && command.type === 'config' ? {...command,status:'failed',error:'Credentials changed. Submit the control command again.',appliedAt:now()} : command);
      });
      res.json({success:true,saved:true,autoTradePaused:true,restartRequired:true,...credentialContext(state,env).flags});
    } catch(error:any) {
      if (error?.message === 'OPEN_LIVE_POSITIONS') res.status(409).json({error:'Selesaikan atau rekonsiliasi seluruh posisi/order live sebelum mengganti kredensial.',code:'OPEN_LIVE_POSITIONS'});
      else res.status(503).json({error:'Kredensial belum tersimpan. Konfigurasi sebelumnya tetap digunakan.',code:'CREDENTIALS_NOT_SAVED'});
    }
  });
  app.get(['/api/stats','/api/old-stats'], (_req,res) => read(res,state => res.json(cloudSnapshot(state,env,now()))));
  app.get('/api/state', (_req,res) => read(res,state => res.json({status:'cloud-daemon',activeEngine:'daemon',isPaperTrading:state.config.isPaperTrading !== false,...workerState(state,now())})));
  app.get('/api/trades', (_req,res) => read(res,state => res.json(modeTrades(state).slice().sort((a,b) => b.timestamp-a.timestamp).slice(0,100).map(t => publicTrade(t,env)))));
  app.get('/api/history', (_req,res) => read(res,state => res.json(modeTrades(state).map(t => publicTrade(t,env)))));
  app.get('/api/logs', (_req,res) => read(res,state => res.json(cloudSnapshot(state,env,now()).logs)));
  app.get('/api/stream', (_req,res) => res.status(410).json({error:'Dashboard memakai snapshot polling terbatas; engine berjalan pada daemon.'}));

  const enqueue = async (res:express.Response,type:'config'|'clearLogs',payload?:Record<string,unknown>, validate?:(state:CloudState)=>void) => {
    const id = randomUUID();
    try {
      await getStore().mutateState(state => {
        if (validate) validate(state);
        if (state.commands.filter(command => !command.status || command.status === 'pending').length >= QUEUE_LIMIT) throw new Error('QUEUE_FULL');
        const command = {id,type,createdAt:now(),status:'pending' as const,...(payload ? {payload} : {})};
        state.commands = [...state.commands.filter(command => !command.status || command.status === 'pending'),...state.commands.filter(command => command.status && command.status !== 'pending').slice(-30),command];
      });
      res.status(202).json({success:true,queued:true,commandId:id,status:'pending'});
    } catch (error:any) {
      if (error?.message === 'QUEUE_FULL') res.status(409).json({error:'Antrean kontrol penuh. Tunggu daemon memproses perintah.',code:'QUEUE_FULL'});
      else res.status(503).json({error:'Perintah belum tersimpan. Konfigurasi aktif belum berubah.',code:'COMMAND_NOT_SAVED'});
    }
  };
  app.post(['/api/config','/api/arbitrage/config'], async (req,res) => {
    let payload:Record<string,unknown>;
    let state:CloudState;
    try { state = await getStore().readState(); }
    catch { res.status(503).json({error:'Penyimpanan bot belum dapat dibaca. Perintah tidak disimpan.',code:'STORAGE_UNAVAILABLE'}); return; }
    try {
      payload = validateControlConfig(req.body,credentialContext(state,env).resolvedEnv) as Record<string,unknown>;
      if (!Object.keys(payload).length) throw new Error('Tidak ada pengaturan untuk diubah.');
    } catch(error:any) { res.status(400).json({error:'Pengaturan tidak valid atau kredensial live belum siap. Periksa format, batas, dan ENABLE_LIVE_TRADING.',code:'INVALID_CONFIG'}); return; }
    return enqueue(res,'config',payload,state => { validateControlConfig(payload,credentialContext(state,env).resolvedEnv); });
  });
  app.post('/api/logs/clear', (req,res) => {
    if (req.body && Object.keys(req.body).length) { res.status(400).json({error:'Perintah clear logs tidak menerima payload.'}); return; }
    return enqueue(res,'clearLogs');
  });
  app.use('/api',(_req,res) => res.status(404).json({error:'API route tidak ditemukan.'}));
  app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction) => {
    res.status(error?.type === 'entity.too.large' ? 413 : 400).json({error:'Payload JSON tidak valid atau terlalu besar.'});
  });
  return app;
}
