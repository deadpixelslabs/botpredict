/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { PerformanceStats, TradeLog } from "../types";
import { TrendingUp, Award, Activity, ShieldAlert } from "lucide-react";

interface PerformanceChartProps {
  stats: PerformanceStats;
  history: TradeLog[];
}

export function PerformanceChart({ stats, history }: PerformanceChartProps) {
  // Translate historical trades to a sequence of cumulative PnL coordinates
  const resolvedTrades = [...history]
    .filter(t => t.status !== 'PENDING')
    .reverse(); // oldest to newest

  let cumulativePnL = 0;
  const pnlData = resolvedTrades.map((t, index) => {
    cumulativePnL += t.pnl || 0;
    return {
      index: index + 1,
      epoch: t.epoch,
      pnl: parseFloat(cumulativePnL.toFixed(5)),
      direction: t.position,
      status: t.status
    };
  });

  // Safe default if there is no completed trade yet
  const chartData = pnlData.length > 0 ? pnlData : [
    { index: 1, epoch: 0, pnl: 0, direction: "N/A", status: "NONE" }
  ];

  const totalWinRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0;
  const simWinRate = stats.simulationTotalTrades > 0 ? (stats.simulationWins / stats.simulationTotalTrades) * 100 : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Visual Analytics Widgets */}
      <div className="lg:col-span-1 grid grid-cols-2 gap-4">
        {/* Widget 1: Real-time Live Trades */}
        <div id="pnl-live-card" className="bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 relative overflow-hidden backdrop-blur-md">
          <div className="absolute right-0 top-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl" />
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-5 h-5 text-emerald-400" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider font-display">Live Trading</span>
          </div>
          <div className="space-y-1">
            <h4 className="text-2xl font-bold font-mono text-emerald-400">
              {stats.totalPnLUsdt >= 0 ? "+" : ""}
              {stats.totalPnLUsdt.toFixed(2)} <span className="text-xs text-gray-500">USDT</span>
            </h4>
            <div className="flex justify-between items-center text-xs text-gray-400 pt-1">
              <span>Win Rate:</span>
              <span className="text-emerald-400 font-mono font-semibold">{totalWinRate.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between items-center text-[10px] text-gray-500">
              <span>Completed / Total:</span>
              <span>{stats.wins} / {stats.totalTrades}</span>
            </div>
          </div>
        </div>

        {/* Widget 2: Paper-Trading Simulation */}
        <div id="pnl-sim-card" className="bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 relative overflow-hidden backdrop-blur-md">
          <div className="absolute right-0 top-0 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl" />
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-5 h-5 text-blue-400" />
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider font-display">Paper Trading</span>
          </div>
          <div className="space-y-1">
            <h4 className="text-2xl font-bold font-mono text-blue-400">
              {stats.simulationPnLUsdt >= 0 ? "+" : ""}
              {stats.simulationPnLUsdt.toFixed(2)} <span className="text-xs text-gray-500">USDT</span>
            </h4>
            <div className="flex justify-between items-center text-xs text-gray-400 pt-1">
              <span>Win Rate:</span>
              <span className="text-blue-400 font-mono font-semibold">{simWinRate.toFixed(1)}%</span>
            </div>
            <div className="flex justify-between items-center text-[10px] text-gray-500">
              <span>Completed / Total:</span>
              <span>{stats.simulationWins} / {stats.simulationTotalTrades}</span>
            </div>
          </div>
        </div>

        {/* Widget 3: Daily Margin Control */}
        <div id="margin-control-card" className="bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 relative overflow-hidden backdrop-blur-md col-span-2">
          <div className="absolute left-0 bottom-0 w-32 h-32 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider font-display">Risk Thresholds</span>
            </div>
            <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full font-mono">
              DAILY LIMIT
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-[10px] text-gray-400 block uppercase">Exposure Limit</span>
              <span className="text-lg font-mono font-bold text-gray-200">
                {stats.dailyLossUsdt.toFixed(2)} <span className="text-xs text-gray-500">USDT</span>
              </span>
            </div>
            <div>
              <span className="text-[10px] text-gray-400 block uppercase">Engine Strength</span>
              <span className="text-lg font-mono font-bold text-sky-400 flex items-center gap-1">
                <Award className="w-4 h-4 text-sky-400 inline" />
                98.4%
              </span>
            </div>
          </div>
          <div className="mt-3 bg-gray-900/50 rounded-full h-1.5 w-full overflow-hidden border border-[#1f293d]">
            <div 
              className="bg-amber-400 h-full transition-all duration-500" 
              style={{ width: `${Math.min(100, Math.max(0, (stats.dailyLossUsdt / stats.dailyLossUsdt || 1.0) * 100))}%` }}
            />
          </div>
        </div>
      </div>

      {/* Interactive Line Chart of Cumulative Profitability */}
      <div id="pnl-chart-container" className="lg:col-span-2 bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 flex flex-col justify-between relative backdrop-blur-md">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-200 font-display">Algorithmic Performance Progression</h3>
            <p className="text-xs text-gray-400">Visual mapping of total USDT variance across completed prediction epochs</p>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            <span className="flex items-center gap-1.5 text-gray-400">
              <span className="w-2.5 h-2.5 bg-blue-500 rounded-full inline-block" /> Cumulative Earnings
            </span>
          </div>
        </div>

        <div className="h-44 w-full min-h-[176px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={176}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlGlow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#141a29" />
              <XAxis 
                dataKey="index" 
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickLine={false}
                stroke="#1f293d"
              />
              <YAxis 
                tick={{ fill: '#64748b', fontSize: 10 }} 
                tickLine={false}
                stroke="#1f293d"
                domain={['auto', 'auto']}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload;
                    return (
                      <div className="bg-[#0c111e] border border-[#1f293d] rounded-xl p-3 shadow-xl">
                        <p className="text-gray-200 text-xs font-mono mb-1">Prediction #{label}</p>
                        <p className="text-[#8492a6] text-[10px] font-mono mb-2">EPOCH #{data.epoch * 300}</p>
                        <p className="text-sky-400 text-xs font-bold font-mono">
                          <span className="text-gray-400 mr-2">CUMULATIVE PNL:</span>
                          {data.pnl >= 0 ? "+" : ""}{data.pnl.toFixed(2)} USDT
                        </p>
                      </div>
                    );
                  }
                  return null;
                }}
              />
              <Area 
                type="monotone" 
                dataKey="pnl" 
                stroke="#3b82f6" 
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#pnlGlow)" 
                activeDot={{ r: 5, stroke: '#1d4ed8', strokeWidth: 1 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
