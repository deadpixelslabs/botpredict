import 'dotenv/config';
import { CloudStore, cloudStorageConfigured } from '../server/cloudStore';
import { PredictFunArbitrageEngine } from '../server/arbitrage-engine';
import { WorkerRuntime } from './runtime';
import { getOrderBuilder, getJwtToken, invalidatePredictAuth } from '../server/predictClient';

const runtime = new WorkerRuntime({
  store: cloudStorageConfigured() ? new CloudStore() : null,
  createEngine: (config, options) => new PredictFunArbitrageEngine(config, options),
  applyCredentials: credentials => {
    // Only the daemon process receives plaintext; no response, log, or snapshot contains these values.
    process.env.PREDICT_FUN_API_KEY = credentials.predictFunApiKey;
    process.env.WALLET_PRIVATE_KEY = credentials.walletPrivateKey;
    process.env.PREDICT_ACCOUNT_ADDRESS = credentials.predictAccountAddress;
    process.env.WALLET_ADDRESS = credentials.walletAddress;
  },
  verifyCredentials: async credentials => {
    const builder = await getOrderBuilder(credentials.walletPrivateKey, credentials.predictAccountAddress);
    invalidatePredictAuth(builder, credentials.predictAccountAddress, credentials.predictFunApiKey);
    await getJwtToken(builder, credentials.predictAccountAddress, credentials.predictFunApiKey);
  },
});

let terminating = false;
async function shutdown(fatal = false): Promise<void> {
  if (terminating) return;
  terminating = true;
  // Daemons normally provide a 30-second grace period. Stop signing immediately.
  const timeout = setTimeout(() => process.exit(1), 25_000);
  timeout.unref();
  await runtime.stop();
  clearTimeout(timeout);
  process.exit(fatal || runtime.faulted ? 1 : 0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
process.once('uncaughtException', () => { void shutdown(true); });
process.once('unhandledRejection', () => { void shutdown(true); });

runtime.run().then(async () => {
  await runtime.stop();
  process.exitCode = runtime.faulted ? 1 : 0;
}).catch(async () => {
  console.error('[Worker] Startup failed. Check private storage and worker configuration.');
  await runtime.stop();
  process.exitCode = 1;
});
