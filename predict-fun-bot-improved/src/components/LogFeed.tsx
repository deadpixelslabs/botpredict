/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TradeLog, LogMessage } from "../types";
import { Terminal, Clock, ExternalLink, RefreshCw, Layers, Sparkles } from "lucide-react";

interface LogFeedProps {
  logs: LogMessage[];
  trades: TradeLog[];
}

export function LogFeed({ logs, trades }: LogFeedProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* 1. Interactive Trade History Ledger (Table) */}
      <div id="trade-ledger-block" className="lg:col-span-2 bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 backdrop-blur-md relative overflow-hidden flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2 mb-4 border-b border-[#1f293d]/50 pb-2">
            <Layers className="w-5 h-5 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-200 font-display">Algorithmic Settlement Ledger</h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse font-mono text-xs text-gray-300">
              <thead>
                <tr className="border-b border-[#1f293d] text-gray-500 font-display text-[10px] uppercase">
                  <th className="py-2.5">Epoch</th>
                  <th className="py-2.5">Time</th>
                  <th className="py-2.5">Signal Pos</th>
                  <th className="py-2.5">Strike Ref Price</th>
                  <th className="py-2.5">Strike Out Price</th>
                  <th className="py-2.5 text-center">Outcome Status</th>
                  <th className="py-2.5 text-right">USDT PnL</th>
                </tr>
              </thead>
              <tbody>
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-gray-500 font-sans text-xs">
                      No positions registered. Setup your credentials or let the algorithm listen to the active BSC prediction epochs.
                    </td>
                  </tr>
                ) : (
                  trades
                    .filter((t, idx, self) => self.findIndex(x => x.id === t.id) === idx)
                    .map((t) => {
                    const isWin = t.status === 'WON' || t.status === 'CLAIMED';
                    const isLoss = t.status === 'LOST';
                    const isDraw = t.status === 'REFUNDED';
                    const isPending = t.status === 'PENDING';
                    const isCanceled = (t.status as string) === 'CANCELED' || (t.status as string) === 'FAILED';

                    return (
                      <tr key={t.id} className="border-b border-[#1f293d]/40 hover:bg-gray-900/10 transition-all">
                        <td className="py-3 font-semibold text-sky-400">#{t.epoch * 300}</td>
                        <td className="py-3 text-gray-500 text-[10px]">
                          {new Date(t.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                        <td className="py-3 font-bold">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] ${
                            t.position === 'BULL' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-500'
                          }`}>
                            {t.position} ({(t.confidence * 100).toFixed(0)}%)
                          </span>
                        </td>
                        <td className="py-3 text-gray-300">
                          ${t.lockPrice?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '—'}
                        </td>
                        <td className="py-3 text-gray-300">
                          ${t.closePrice?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '—'}
                        </td>
                        <td className="py-3 text-center">
                          <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-semibold tracking-wider block mx-auto w-max ${
                            isWin ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20' :
                            isLoss ? 'bg-red-500/15 text-red-400 border border-red-500/20' :
                            isDraw ? 'bg-gray-800 text-gray-400' : 
                            isCanceled ? 'bg-gray-800/80 text-gray-500 border border-gray-700/50' :
                            'bg-blue-500/15 text-blue-400 border border-blue-500/20 animate-pulse'
                          }`}>
                            {t.status}
                          </span>
                        </td>
                        <td className={`py-3 text-right font-bold ${
                          isWin ? 'text-emerald-400' :
                          isLoss ? 'text-red-400' : 'text-gray-400'
                        }`}>
                          {t.pnl ? `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(5)}` : (isPending ? 'PENDING' : '0')}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Dynamic transaction verification index */}
        <div className="border-t border-[#1f293d]/50 pt-3 mt-4 flex flex-col md:flex-row md:items-center justify-between text-[11px] text-gray-500 gap-2 font-sans font-medium">
          <span className="flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            Automatic smart contract claims triggers automatically on validated outcomes
          </span>
          <a
            href="https://bscscan.com/address/0xd172f3fbabe763ee8e52d8b32421574236da6057"
            target="_blank" 
            rel="noreferrer"
            className="text-sky-400 hover:text-sky-300 transition-all flex items-center gap-1 font-mono hover:underline"
          >
            Predict.fun Contract Explorer <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {/* 2. Quantum Engine Shell Output (Terminal Logs) */}
      <div id="terminal-logs-block" className="lg:col-span-1 bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 backdrop-blur-md flex flex-col justify-between h-[360px] relative">
        <div className="flex items-center justify-between border-b border-[#1f293d]/50 pb-3 mb-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-5 h-5 text-gray-400" />
            <h3 className="text-sm font-semibold text-gray-200 font-display">System Shell Pipe</h3>
          </div>
          <Clock className="w-4 h-4 text-gray-500 animate-spin" style={{ animationDuration: '10s' }} />
        </div>

        {/* Log rows scrolling element */}
        <div className="flex-1 overflow-y-auto space-y-3 pr-1 font-mono text-[10px] text-gray-400 scroll-smooth">
          {logs.length === 0 ? (
            <div className="text-center py-20 text-gray-600">
              Initializing live system trace logs...
            </div>
          ) : (
            logs.map((log) => {
              const dateObj = new Date(log.timestamp);
              const timeString = dateObj.toLocaleTimeString('en-US', { hour12: false });
              
              let rowStyle = 'text-gray-400';
              if (log.level === 'warn') rowStyle = 'text-amber-400';
              if (log.level === 'error') rowStyle = 'text-red-400 font-semibold';
              if (log.level === 'success') rowStyle = 'text-emerald-400 font-semibold';

              return (
                <div key={log.id} className="flex gap-2 items-start border-l border-[#1f293d] pl-2 hover:bg-gray-900/5 py-0.5">
                  <span className="text-gray-600 select-none font-medium">{timeString}</span>
                  <span className={rowStyle}>{log.message}</span>
                </div>
              );
            })
          )}
        </div>

        <div className="border-t border-[#1f293d]/40 pt-3.5 text-[10px] text-gray-500 leading-normal font-sans">
          Algorithmic threads monitoring pricing channels (Binance klines/websocket) and BSC on-chain consensus state.
        </div>
      </div>
    </div>
  );
}
