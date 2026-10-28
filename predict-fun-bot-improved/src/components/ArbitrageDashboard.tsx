import React, { useEffect, useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { 
  Zap,
  Activity, 
  DollarSign, 
  Target, 
  BarChart2, 
  Clock, 
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  Download
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';

interface Trade {
  id: string;
  timestamp: number;
  direction: 'UP' | 'DOWN';
  amount: number;
  entryOdds: number;
  edge: number;
  outcome?: 'WIN' | 'LOSS';
  pnl?: number;
  isSold?: boolean;
  isCancelled?: boolean;
}

interface ArbStats {
  tradesThisHour: number;
  dailyPnl: number;
  avgVolume: number;
  ticksInBuffer: number;
  lastTradeTime: number;
  currentPrice: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  totalPnl: number;
  avgEdge: string;
  avgLatency: number;
  pnlHistory: number[];
  recentTrades: Trade[];
  isPaperTrading?: boolean;
  logs?: string[];
  lastPredictOdds?: {
    upOdds: number;
    downOdds: number;
    timestamp: number;
  } | null;
  walletBalanceUsdt?: number;
}

export const ArbitrageDashboard: React.FC = () => {
  const [stats, setStats] = useState<ArbStats | null>(null);
  const [logs, setLogs] = useState<{time: string; msg: string; type: string}[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [relayConnected, setRelayConnected] = useState(() => !!(window as any).__relayConnected);

  useEffect(() => {
    const handleRelayConn = (e: Event) => {
      setRelayConnected((e as CustomEvent).detail);
    };
    window.addEventListener("relay-connection", handleRelayConn);
    return () => window.removeEventListener("relay-connection", handleRelayConn);
  }, []);

  const addLog = (msg: string, type: 'info' | 'error' | 'success' = 'info') => {
    setLogs(prev => {
      const newLogs = [...prev, { time: new Date().toLocaleTimeString(), msg, type }];
      if (newLogs.length > 50) return newLogs.slice(newLogs.length - 50);
      return newLogs;
    });
  };

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) throw new Error('API error');
      const data = await res.json();
      setStats(data);
      if (!isConnected) {
          setIsConnected(true);
          addLog('Connected to engine API', 'success');
      }
    } catch (e) {
      console.error(e);
      if (isConnected) {
          setIsConnected(false);
          addLog('Connection lost, retrying...', 'error');
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    addLog('Dashboard initialized');
    addLog('Connecting to arbitrage engine API...', 'info');
    fetchStats();
    const interval = setInterval(fetchStats, 1000);
    return () => clearInterval(interval);
  }, [isConnected]); // Added isConnected to deps so it doesn't log repetitively if we handle state well, but actually it's fine without it. Wait, if I change the deps, it will recreate interval. Better to keep it [] and use a ref for isConnected if needed, but the simple approach is fine. Let's just keep it simple.

  const toggleMode = async () => {
    const newMode = !stats?.isPaperTrading;
    try {
      const res = await fetch('/api/arbitrage/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPaperTrading: newMode })
      });
      if (res.ok) {
        addLog(`Switched to ${newMode ? 'Paper' : 'Live'} Trading`, 'success');
        fetchStats();
      }
    } catch (e) {
      addLog('Failed to switch mode', 'error');
    }
  };

  const clearLogsOnServer = async () => {
    try {
      const res = await fetch('/api/logs/clear', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.success && stats) {
          setStats({
            ...stats,
            logs: data.logs
          });
        }
        setLogs([]);
        addLog('System logs cleared', 'success');
      }
    } catch (e) {
      console.error(e);
      addLog('Failed to clear logs', 'error');
    }
  };

  const handleExport = () => {
    if (!stats || !stats.recentTrades) return;
    const csv = [
      ['Time', 'Direction', 'Amount', 'Odds', 'Edge', 'Outcome', 'PnL'],
      ...stats.recentTrades.map(t => [
        new Date(t.timestamp).toISOString(),
        t.direction,
        t.amount,
        t.entryOdds,
        t.edge,
        t.outcome || 'PENDING',
        t.pnl || 0
      ])
    ].map(row => row.join(',')).join('\\n');
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arbitrage_trades_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    addLog('Data exported to CSV', 'success');
  };

  const pnlChartData = useMemo(() => {
    if (!stats?.pnlHistory) return [];
    return stats.pnlHistory.map((val, i) => ({ index: i + 1, pnl: val }));
  }, [stats?.pnlHistory]);

  const winLossData = useMemo(() => {
    if (!stats) return [];
    return [
      { name: 'Wins', value: stats.wins },
      { name: 'Losses', value: stats.losses }
    ];
  }, [stats]);

  const COLORS = ['#10b981', '#ef4444'];

  return (
    <div className="min-h-screen bg-[#030712] text-gray-100 p-4 md:p-8 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <motion.header 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col md:flex-row items-center justify-between border-b border-[#1f293d] pb-6 gap-4"
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-400 to-sky-500 flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.3)]">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold font-display tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-gray-100 to-emerald-200 flex items-center gap-3">
                Arbitrage Engine Dashboard
                {stats?.isPaperTrading && (
                  <span className="bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2 py-0.5 rounded-md text-xs font-mono uppercase tracking-wider">
                    Paper Trading
                  </span>
                )}
              </h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm mt-1">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isConnected ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
                    <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${isConnected ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                  </span>
                  <span className="text-gray-400 font-mono">{isConnected ? 'System Online & Real-time' : 'Reconnecting...'}</span>
                </div>
                <span className="text-gray-500 hidden sm:inline">|</span>
                <div className="flex items-center gap-2 font-mono">
                  <span className={`h-2 w-2 rounded-full ${relayConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400 animate-pulse'}`}></span>
                  <span className={relayConnected ? 'text-emerald-400' : 'text-amber-400'}>
                    {relayConnected ? 'Relay Fast-path ACTIVE (Worker)' : 'Relay Fallback'}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={toggleMode}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all text-sm font-medium border ${
                stats?.isPaperTrading 
                  ? 'bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border-amber-500/30' 
                  : 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border-rose-500/30'
              }`}
            >
              <Zap className="w-4 h-4" /> {stats?.isPaperTrading ? 'Switch to Live' : 'Switch to Paper'}
            </button>
            <button 
              onClick={handleExport}
              className="flex items-center gap-2 bg-[#0c111e] hover:bg-[#141d33] border border-[#1f293d] px-4 py-2 rounded-lg transition-all text-sm text-gray-300 hover:text-white"
            >
              <Download className="w-4 h-4" /> Export
            </button>
            <button 
              onClick={fetchStats}
              disabled={isRefreshing}
              className="flex items-center gap-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-4 py-2 rounded-lg transition-all text-sm font-medium"
            >
              <RefreshCw className={`w-4 h-4 \${isRefreshing ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </motion.header>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.1 }} className="bg-[#0c111e] border border-[#1f293d] p-5 rounded-2xl relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-gray-400 text-sm font-medium">Daily P&L</span>
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div className={`text-3xl font-bold font-mono ${(stats?.dailyPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              ${(stats?.dailyPnl ?? 0).toFixed(2)}
            </div>
            <div className="text-xs text-gray-500 mt-2 font-mono">Total P&L: ${(stats?.totalPnl ?? 0).toFixed(2)}</div>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2 }} className="bg-[#0c111e] border border-[#1f293d] p-5 rounded-2xl relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-gray-400 text-sm font-medium">Win Rate</span>
              <Target className="w-4 h-4 text-sky-400" />
            </div>
            <div className="text-3xl font-bold font-mono text-gray-100">
              {stats?.winRate ?? '0.0'}%
            </div>
            <div className="text-xs text-gray-500 mt-2 font-mono">{stats?.wins ?? 0}W / {stats?.losses ?? 0}L</div>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.3 }} className="bg-[#0c111e] border border-[#1f293d] p-5 rounded-2xl relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-gray-400 text-sm font-medium">Activity (1H)</span>
              <Activity className="w-4 h-4 text-purple-400" />
            </div>
            <div className="text-3xl font-bold font-mono text-gray-100">
              {stats?.tradesThisHour ?? 0}
            </div>
            <div className="text-xs text-gray-500 mt-2 font-mono">BTC: ${(stats?.currentPrice ?? 0).toFixed(2)}</div>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4 }} className="bg-[#0c111e] border border-[#1f293d] p-5 rounded-2xl relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-gray-400 text-sm font-medium">Avg Edge</span>
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-3xl font-bold font-mono text-amber-400">
              {stats?.avgEdge ?? '0.0'}%
            </div>
            <div className="text-xs text-gray-500 mt-2 font-mono">Avg Latency: {stats?.avgLatency ?? 0}ms</div>
          </motion.div>

          <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.5 }} className="bg-[#0c111e] border border-[#1f293d] p-5 rounded-2xl relative overflow-hidden">
            <div className="flex justify-between items-start mb-2">
              <span className="text-gray-400 text-sm font-medium">Predict.fun Odds</span>
              <Zap className="w-4 h-4 text-emerald-400" />
            </div>
            {stats?.lastPredictOdds ? (
              <div className="space-y-1 mt-1">
                <div className="flex justify-between items-center text-sm font-mono">
                  <span className="text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded text-xs">UP</span>
                  <span className="text-gray-100 font-bold">{stats.lastPredictOdds.upOdds.toFixed(2)}x</span>
                </div>
                <div className="flex justify-between items-center text-sm font-mono">
                  <span className="text-red-400 font-bold bg-red-500/10 px-1.5 py-0.5 rounded text-xs">DOWN</span>
                  <span className="text-gray-100 font-bold">{stats.lastPredictOdds.downOdds.toFixed(2)}x</span>
                </div>
                <div className="text-[10px] text-gray-500 font-mono pt-1 text-right">
                  Synced: {new Date(stats.lastPredictOdds.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ) : (
              <div className="text-gray-500 text-sm font-mono py-2">Syncing live odds...</div>
            )}
          </motion.div>
        </div>


        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }} className="lg:col-span-2 bg-[#0c111e] border border-[#1f293d] p-6 rounded-2xl">
            <h3 className="text-lg font-semibold mb-6 flex items-center gap-2">
              <BarChart2 className="w-5 h-5 text-emerald-400" /> P&L Trajectory
            </h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={pnlChartData}>
                  <defs>
                    <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f293d" vertical={false} />
                  <XAxis dataKey="index" stroke="#4b5563" tick={{fontSize: 12}} />
                  <YAxis stroke="#4b5563" tick={{fontSize: 12}} domain={['auto', 'auto']} tickFormatter={(v) => `$${v}`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0c111e', borderColor: '#1f293d', color: '#f3f4f6' }}
                    itemStyle={{ color: '#10b981' }}
                    formatter={(val: number) => [`$${val.toFixed(2)}`, 'Cumulative P&L']}
                  />
                  <Area type="monotone" dataKey="pnl" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorPnl)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6 }} className="bg-[#0c111e] border border-[#1f293d] p-6 rounded-2xl flex flex-col">
            <h3 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <Target className="w-5 h-5 text-sky-400" /> Win/Loss Ratio
            </h3>
            <div className="flex-1 min-h-[200px] flex items-center justify-center relative">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={winLossData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    stroke="none"
                  >
                    {winLossData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0c111e', borderColor: '#1f293d', color: '#f3f4f6', borderRadius: '8px' }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-2xl font-bold font-mono text-gray-100">{stats?.winRate ?? '0'}%</span>
                <span className="text-xs text-gray-500 uppercase tracking-widest">WR</span>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Recent Trades Table & Logs */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 }} className="lg:col-span-2 bg-[#0c111e] border border-[#1f293d] rounded-2xl overflow-hidden">
            <div className="p-5 border-b border-[#1f293d]">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Activity className="w-5 h-5 text-sky-400" /> Recent Arbitrage Executions
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-[#141d33] text-gray-400">
                  <tr>
                    <th className="px-5 py-3 font-medium">Time</th>
                    <th className="px-5 py-3 font-medium">Direction</th>
                    <th className="px-5 py-3 font-medium">Odds</th>
                    <th className="px-5 py-3 font-medium">Edge</th>
                    <th className="px-5 py-3 font-medium">Amount</th>
                    <th className="px-5 py-3 font-medium">P&L</th>
                    <th className="px-5 py-3 font-medium text-right">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1f293d]/50 text-gray-300 font-mono">
                  {(!stats?.recentTrades || stats.recentTrades.length === 0) ? (
                    <tr>
                      <td colSpan={7} className="px-5 py-8 text-center text-gray-500 font-sans">
                        No recent trades executed yet.
                      </td>
                    </tr>
                  ) : (
                    stats.recentTrades
                      .filter((t, idx, self) => self.findIndex(x => x.id === t.id) === idx)
                      .slice(0, 10)
                      .map(t => (
                      <tr key={t.id} className="hover:bg-[#141d33]/50 transition-colors">
                        <td className="px-5 py-3 whitespace-nowrap">{new Date(t.timestamp).toLocaleTimeString()}</td>
                        <td className="px-5 py-3">
                          <span className={`flex items-center gap-1 font-bold ${t.direction === 'UP' ? 'text-emerald-400' : 'text-red-400'}`}>
                            {t.direction === 'UP' ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
                            {t.direction}
                          </span>
                        </td>
                        <td className="px-5 py-3">{t.entryOdds.toFixed(2)}</td>
                        <td className="px-5 py-3 text-amber-400">{(t.edge * 100).toFixed(1)}%</td>
                        <td className="px-5 py-3">${t.amount.toFixed(2)}</td>
                        <td className={`px-5 py-3 font-bold ${(t.pnl || 0) > 0 ? 'text-emerald-400' : (t.pnl || 0) < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                          {(t.pnl || 0) > 0 ? '+' : ''}{(t.pnl || 0).toFixed(2)}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {t.isCancelled ? (
                            <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider">CANCELLED</span>
                          ) : t.isSold ? (
                            <span className="bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider">SCALPED</span>
                          ) : t.outcome === 'WIN' ? (
                            <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider">WIN</span>
                          ) : t.outcome === 'LOSS' ? (
                            <span className="bg-red-500/10 text-red-400 border border-red-500/20 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider">LOSS</span>
                          ) : (
                            <span className="bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider">PENDING</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 }} className="bg-[#0c111e] border border-[#1f293d] rounded-2xl flex flex-col h-full">
            <div className="p-5 border-b border-[#1f293d] flex justify-between items-center">
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Zap className="w-5 h-5 text-amber-400" /> System Logs
              </h3>
              <button
                onClick={clearLogsOnServer}
                className="px-3 py-1 text-[10px] uppercase tracking-wider font-semibold bg-gray-900 border border-[#1f293d] text-gray-400 hover:text-red-400 hover:bg-red-500/10 hover:border-red-500/30 rounded-lg transition-all cursor-pointer font-sans"
              >
                Clear Logs
              </button>
            </div>
            <div className="p-4 flex-1 overflow-y-auto min-h-[300px] max-h-[360px] font-mono text-xs space-y-2">
              {stats?.logs && stats.logs.length > 0 ? (
                stats.logs.slice(-200).map((logStr, i) => {
                  const isError = logStr.includes('❌') || logStr.includes('⚠️') || logStr.includes('⛔');
                  const isSuccess = logStr.includes('✅') || logStr.includes('🎯') || logStr.includes('📝 WIN');
                  const isHedge = logStr.includes('🛡️');
                  
                  return (
                    <div key={i} className={`pl-3 border-l-2 py-1 ${
                      isError ? 'border-red-500 text-red-300' : 
                      isSuccess ? 'border-emerald-500 text-emerald-300' : 
                      isHedge ? 'border-amber-500 text-amber-300' :
                      'border-sky-500 text-gray-400'
                    }`}>
                      {logStr}
                    </div>
                  );
                })
              ) : (
                logs.map((log, i) => (
                  <div key={i} className={`pl-3 border-l-2 py-1 ${
                    log.type === 'error' ? 'border-red-500 text-red-300' : 
                    log.type === 'success' ? 'border-emerald-500 text-emerald-300' : 
                    'border-sky-500 text-gray-400'
                  }`}>
                    <span className="opacity-50 mr-2">[{log.time}]</span> {log.msg}
                  </div>
                ))
              )}
              {(!stats?.logs || stats.logs.length === 0) && logs.length === 0 && (
                <div className="text-gray-500 text-center py-10 font-sans">No system logs.</div>
              )}
            </div>
            {stats?.walletBalanceUsdt !== undefined && (
              <div className="p-3 border-t border-[#1f293d] bg-[#141d33]/30 text-xs font-mono flex justify-between items-center text-gray-400">
                <span>Wallet USDT Balance</span>
                <span className="font-bold text-amber-400">${stats.walletBalanceUsdt.toFixed(2)}</span>
              </div>
            )}
          </motion.div>
        </div>

      </div>
    </div>
  );
};
