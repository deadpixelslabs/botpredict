import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import { arbitrageEngine, startArbitrage, getArbitrageStats, updateArbitrageConfig, clearArbitrageLogs } from "./server/arbitrage-engine";

import { publicConfig, sameOriginRequest, validControlToken, validateControlConfig } from './server/controlConfig';

const app = express();
app.disable('x-powered-by');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && (process.env.BOT_CONTROL_TOKEN?.length || 0) < 24) {
  throw new Error('Binding outside localhost requires a BOT_CONTROL_TOKEN of at least 24 characters');
}

// Middleware for JSON payloads
app.use(express.json({ limit: '16kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!sameOriginRequest(req.get('origin'), req.get('host'))) {
      res.status(403).json({ error: 'Cross-origin control requests are blocked' }); return;
    }
    if (!validControlToken(req.get('authorization'), process.env.BOT_CONTROL_TOKEN)) {
      res.status(401).json({ error: 'Enter the control token configured on the server' }); return;
    }
  }
  next();
});
app.get('/api/health', (_req, res) => res.json({ ok: true, offline: process.env.BOT_OFFLINE === 'true' }));

// Start Arbitrage Engine
if (process.env.BOT_OFFLINE !== 'true') startArbitrage().catch(console.error);

// Arbitrage Engine Endpoints
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
});

function updateConfig(req: express.Request, res: express.Response) {
  try {
    const changes = validateControlConfig(req.body);
    const previous = { ...arbitrageEngine.cfg };
    updateArbitrageConfig(changes);
    try {
      const configPath = path.join(process.cwd(), 'data', 'config.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const tempPath = configPath + '.tmp';
      const config = publicConfig(arbitrageEngine.cfg);
      fs.writeFileSync(tempPath, JSON.stringify({ ...config, isLiveTrading: !config.isPaperTrading }, null, 2), { mode: 0o600 });
      fs.renameSync(tempPath, configPath);
    } catch (error) {
      updateArbitrageConfig(previous);
      throw error;
    }
    res.json({ success: true, config: publicConfig(arbitrageEngine.cfg), isPaperTrading: arbitrageEngine.cfg.isPaperTrading });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
}
app.post('/api/arbitrage/config', updateConfig);

function currentModeTrades() {
  const mode = arbitrageEngine.cfg.isPaperTrading ? 'paper' : 'live';
  return arbitrageEngine.trades.filter(t => (t as any).mode === mode);
}

app.get('/api/stats', (req, res) => {
    try {
        const stats = getArbitrageStats();
        
        // Calculate additional arbitrage metrics
        const completedTrades = currentModeTrades().filter(t => t.outcome);
        
        const avgEdge = completedTrades.length > 0
            ? (completedTrades.reduce((sum, t) => sum + t.edge, 0) / completedTrades.length * 100).toFixed(1)
            : '0.0';
        
        const avgLatency = completedTrades.length > 0
            ? Math.round(completedTrades.reduce((sum, t) => sum + (t.signal?.latencyMs ?? 0), 0) / completedTrades.length)
            : 0;
            
        // PnL history (last 20 trades)
        const pnlHistory = completedTrades
            .sort((a, b) => (a.resolvedAt || a.timestamp) - (b.resolvedAt || b.timestamp))
            .slice(-20)
            .reduce((acc: number[], t) => {
                const prev = acc.length > 0 ? acc[acc.length - 1] : 0;
                acc.push(prev + (t.pnl ?? 0));
                return acc;
            }, [] as number[]);
            
        const nowSec = Math.floor(Date.now() / 1000);
        const activeTrades = currentModeTrades().filter(
          (t) => !t.resolved && !t.isSold && !t.isCancelled
        ).length;

        res.json({
            ...stats,
            epochSecond: nowSec % 300,
            epochStart: Math.floor(nowSec / 300) * 300,
            activeTrades,
            serverTime: Date.now(),
            avgEdge,
            avgLatency,
            pnlHistory,
            recentTrades: currentModeTrades().slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 25)
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Backward compatibility stats for old UI redirected to Arbitrage Engine
app.get("/api/state", (req, res) => {
  try {
    res.json({
      status: "arbitrage",
      isPaperTrading: arbitrageEngine.cfg.isPaperTrading,
      activeEngine: "arbitrage"
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/old-stats", (req, res) => {
  try {
    res.json(getArbitrageStats());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/history", (req, res) => {
  try {
    res.json(arbitrageEngine.trades);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/trades", (req, res) => {
  try {
    res.json(currentModeTrades().slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 100));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/logs", (req, res) => {
  try {
    res.json(getArbitrageStats().logs || []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/logs/clear", (req, res) => {
  try {
    clearArbitrageLogs();
    res.json({ success: true, logs: getArbitrageStats().logs || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/config", (req, res) => {
  try {
    res.json({ ...publicConfig(arbitrageEngine.cfg), controlTokenRequired: !!process.env.BOT_CONTROL_TOKEN, liveTradingEnabled: process.env.ENABLE_LIVE_TRADING === 'true' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/config', updateConfig);

app.get("/api/retrospective", (req, res) => {
  try {
    res.json({ status: "disabled", message: "Retrospective learning is disabled in favor of Arbitrage Engine." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/retrospective/trigger", async (req, res) => {
  try {
    res.json({ success: true, report: "Retrospective learning disabled. Focused on 100% Arbitrage Engine." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Real-time Event Streaming via Server-Sent Events (SSE)
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Send initial load
  const sendUpdate = () => {
    try {
      const stats = getArbitrageStats();
      const data = {
        state: { status: "arbitrage", isPaperTrading: arbitrageEngine.cfg.isPaperTrading },
        stats: stats,
        history: currentModeTrades().slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 10), // send active/recent fast
        logs: (stats.logs || []).slice(0, 15)
      };
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      // client disconnected
    }
  };

  sendUpdate();

  // Stream updates every 3 seconds
  const interval = setInterval(sendUpdate, 3000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

// Dashboard UI
async function startServer() {
  app.use(express.static(path.join(process.cwd(), "public")));
  app.get("*", (req, res) => {
    res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`Server started at http://${HOST}:${PORT}`);
  });
  const shutdown = async () => {
    setTimeout(() => process.exit(1), 5000).unref();
    try { await import('./server/arbitrage-engine').then(m => m.stopArbitrage()); }
    catch { console.error('Shutdown completed with a ledger error; inspect data before restarting.'); }
    finally { server.close(() => process.exit(0)); }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch(err => {
  console.error("Critical error bootstrapping full-stack Express app:", err);
});
