/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PredictionState } from "../types";
import { Cpu, Zap, Landmark, Compass, Eye, ShieldCheck, ChevronRight, Activity, ArrowUpRight, ArrowDownRight, Clock } from "lucide-react";

interface TradingConsoleProps {
  state: PredictionState;
  isLive: boolean;
}

export function TradingConsole({ state, isLive }: TradingConsoleProps) {
  // Format minutes and seconds for countdown
  const minutes = Math.floor(state.secondsRemaining / 60);
  const seconds = state.secondsRemaining % 60;
  const timeFormatted = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

  // Time progress bar percentage
  // Predict.fun prediction intervals default to 5 minutes (900 seconds)
  const totalDuration = 300;
  const progressPercent = Math.max(0, Math.min(100, ((totalDuration - state.secondsRemaining) / totalDuration) * 100));

  // Determine active signal styling classes
  const isUp = state.aiPrediction?.direction === "BULL";
  const isDown = state.aiPrediction?.direction === "BEAR";
  const isHold = state.aiPrediction?.direction === "HOLD" || !state.aiPrediction;

  const totalPoolUsdt = state.bullAmount + state.bearAmount;
  const bullPercentage = totalPoolUsdt === 0 ? 50 : (state.bullAmount / totalPoolUsdt) * 100;
  const bearPercentage = totalPoolUsdt === 0 ? 50 : (state.bearAmount / totalPoolUsdt) * 100;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-3 gap-6">
      {/* 1. Live Countdown and Ticker */}
      <div id="live-timer-card" className="bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 flex flex-col justify-between backdrop-blur-md relative overflow-hidden">
        <div className="absolute right-0 top-0 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-emerald-400 animate-ping' : 'bg-blue-400 animate-ping'}`} />
            <span className="text-xs text-gray-400 font-mono font-medium">
              {isLive ? 'LIVE NODE ACTIVE' : 'SIMULATOR ACTIVE'}
            </span>
          </div>
          <span className="text-[10px] bg-sky-500/15 text-sky-400 border border-sky-500/20 px-2 py-0.5 rounded-full font-mono font-semibold">
            EPOCH #{state.currentEpoch * 300}
          </span>
        </div>

        <div className="my-5 text-center">
          <span className="text-[10px] text-gray-400 uppercase tracking-widest block font-display">BTI Countdown</span>
          <span className="text-4xl font-extrabold font-mono text-gray-100 tracking-wider">
            {timeFormatted}
          </span>

          <div className="mt-3 bg-gray-900/60 rounded-full h-2 w-full overflow-hidden border border-[#1f293d]/80 relative p-[1px]">
            <div 
              className={`h-full rounded-full transition-all duration-1000 ${
                state.secondsRemaining < 45 ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]' : 'bg-sky-400'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-gray-500 mt-1 font-mono">
            <span>Bidding Window</span>
            <span>Close Round</span>
          </div>
        </div>

        <div className="border-t border-[#1f293d]/60 pt-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Landmark className="w-4 h-4 text-gray-400" />
            <span className="text-xs text-gray-400 font-display">BTC Price</span>
          </div>
          <span className="text-sm font-bold font-mono text-gray-200">
            ${state.btcPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      {/* 2. Onchain Pool Ratios */}
      <div id="liquidity-ratio-card" className="bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 flex flex-col justify-between backdrop-blur-md relative overflow-hidden">
        <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-full blur-2xl pointer-events-none" />
        <div className="flex items-center justify-between border-b border-[#1f293d]/40 pb-3">
          <div className="flex items-center gap-2">
            <Compass className="w-5 h-5 text-purple-400" />
            <h3 className="text-sm font-semibold text-gray-300 font-display">Contract Weight Pool</h3>
          </div>
          <span className="text-xs text-gray-400 font-mono font-medium">Predict.fun</span>
        </div>

        <div className="space-y-4 my-4">
          {/* Progress Bar Weight Map */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-emerald-400 font-bold">BULL {bullPercentage.toFixed(0)}%</span>
              <span className="text-red-400 font-bold">BEAR {bearPercentage.toFixed(0)}%</span>
            </div>
            <div className="flex h-3 w-full overflow-hidden rounded-md border border-[#1f293d] bg-gray-900 p-[1px]">
              <div 
                className="bg-emerald-500/85 rounded-l-md transition-all duration-500" 
                style={{ width: `${bullPercentage}%` }}
              />
              <div 
                className="bg-red-500/85 rounded-r-md transition-all duration-500" 
                style={{ width: `${bearPercentage}%` }}
              />
            </div>
          </div>

          {/* Multiplier outputs */}
          <div className="grid grid-cols-2 gap-3 font-mono text-center">
            <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-2.5">
              <span className="text-[10px] text-gray-400 block uppercase">Bull Payout</span>
              <span className="text-lg font-bold text-emerald-400">{state.bullPayout}x</span>
              <span className="text-[9px] text-gray-500 block">{state.bullAmount.toFixed(2)} USDT</span>
            </div>
            <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-2.5">
              <span className="text-[10px] text-gray-400 block uppercase">Bear Payout</span>
              <span className="text-lg font-bold text-red-400">{state.bearPayout}x</span>
              <span className="text-[9px] text-gray-500 block">{state.bearAmount.toFixed(2)} USDT</span>
            </div>
          </div>
        </div>

        <div className="flex justify-between items-center text-[10px] text-gray-500 border-t border-[#1f293d]/40 pt-3">
          <span>Active Weight Cap:</span>
          <span className="font-mono font-semibold">{totalPoolUsdt.toFixed(2)} USDT</span>
        </div>
      </div>

      {/* 3. AI Predictive Advisor */}
      <div id="ai-advisor-card" className={`bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-5 flex flex-col justify-between backdrop-blur-md relative overflow-hidden transition-all duration-300 ${
        isUp ? 'glow-green' : isDown ? 'glow-red' : 'glow-blue'
      }`}>
        <div className="flex items-center justify-between border-b border-[#1f293d]/40 pb-3">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-blue-400 animate-pulse" />
            <h3 className="text-sm font-semibold text-gray-300 font-display">CLAUDE AI Brain Executor</h3>
          </div>
          <span className="text-[10px] bg-blue-500/15 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full font-mono font-semibold">
            DECISION ENGINE
          </span>
        </div>

        {/* AI Prediction Status Block */}
        <div className="my-3 space-y-2">
          {isHold ? (
            <div className="bg-gray-800/15 border border-gray-800/40 p-3 rounded-xl flex items-center gap-3">
              <Eye className="w-5 h-5 text-gray-400" />
              <div>
                <span className="text-xs font-bold text-gray-300 font-display block">MONITORING MARKET</span>
                <span className="text-[10px] text-gray-400 block font-mono">Formulating prediction during first minute of epoch...</span>
              </div>
            </div>
          ) : (
            <div className="bg-gray-900/60 rounded-xl p-3 border border-[#1f293d]/50 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Zap className={`w-5 h-5 ${isUp ? 'text-emerald-400' : 'text-red-400'}`} />
                  <div>
                    <span className={`text-xs font-bold font-display block ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                      SIGNAL: {state.aiPrediction?.direction}
                    </span>
                    <span className="text-[10px] text-gray-400 block font-mono">
                      Confidence: {((state.aiPrediction?.confidence || 0) * 100).toFixed(0)}%
                    </span>
                  </div>
                </div>
                <ShieldCheck className={`w-5 h-5 ${isUp ? 'text-emerald-500' : 'text-red-500'}`} />
              </div>
              
              {/* Dynamic Risk & Bet sizing weights */}
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono pt-2 border-t border-gray-800/50">
                <div>
                  <span className="text-gray-500 block uppercase">Profil Risiko</span>
                  <span className={`font-bold uppercase ${
                    (state.aiPrediction as any)?.riskLevel === 'LOW' ? 'text-emerald-400' :
                    (state.aiPrediction as any)?.riskLevel === 'HIGH' ? 'text-rose-400' : 'text-amber-400'
                  }`}>
                    {(state.aiPrediction as any)?.riskLevel || 'MEDIUM'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-500 block uppercase">Pengali Nilai Taruhan</span>
                  <span className="font-bold text-sky-400">
                    {(state.aiPrediction as any)?.suggestedBetMultiplier ? `${(state.aiPrediction as any).suggestedBetMultiplier}x` : '1.0x'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Cerebras Background Macro Strategy */}
          <div className="bg-[#0f1a30]/45 rounded-xl p-3 border border-emerald-500/10">
            <div className="flex items-center gap-1.5 mb-1.5 select-none">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
              <span className="text-[9px] font-extrabold text-emerald-400 tracking-wider font-display uppercase">
                Panel Sinyal Cerebras LLM & Hybrid Brain
              </span>
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed font-mono">
              {state.macroStrategy || "Menyinkronkan analitik Claude AI & Cerebras Brain... Mensintesis data m1, order book, dan rezim..."}
            </p>
          </div>

          {/* AI Reason string */}
          <div className="bg-gray-900/60 rounded-xl p-3 border border-[#1f293d]/50">
            <div className="text-[9px] text-gray-500 font-display mb-1 select-none uppercase tracking-wider font-bold">Inti Prediksi (Otak Makro)</div>
            <p className="text-xs text-gray-300 leading-relaxed font-mono whitespace-pre-wrap">
              {state.aiPrediction ? state.aiPrediction.reasoning : "Standby. Modul prediksi makro sedang menunggu agregasi momentum teknikal..."}
            </p>
            {state.aiPrediction?.detailedSignals && state.aiPrediction.detailedSignals.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#1f293d]/50">
                <div className="text-[9px] text-gray-500 font-display mb-2 select-none uppercase tracking-wider font-bold">Detail Sinyal Kuantitatif</div>
                <div className="grid grid-cols-2 gap-2">
                  {state.aiPrediction.detailedSignals.map((sig, idx) => (
                    <div key={idx} className="flex justify-between items-center bg-[#0c111e]/50 p-1.5 rounded border border-[#1f293d]/30">
                      <span className="text-[10px] text-gray-400 font-mono">{sig.key}</span>
                      <span className={`text-[10px] font-bold font-mono ${typeof sig.score === 'number' && sig.score > 0 ? 'text-emerald-400' : typeof sig.score === 'number' && sig.score < 0 ? 'text-red-400' : 'text-gray-300'}`}>
                        {typeof sig.score === 'number' ? sig.score.toFixed(4) : sig.score}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Dynamic Indicator Micro Tags */}
        <div className="grid grid-cols-3 gap-2 text-[10px] text-center font-mono pt-3 border-t border-[#1f293d]/40 text-gray-400">
          <div>
            <span className="block text-[9px] text-gray-500">RSI</span>
            <span className={state.aiPrediction?.indicators?.rsi ? 'text-gray-300' : ''}>
              {state.aiPrediction?.indicators?.rsi ? state.aiPrediction.indicators.rsi.toFixed(1) : "—"}
            </span>
          </div>
          <div>
            <span className="block text-[9px] text-gray-500">MOMENTUM</span>
            <span className={state.aiPrediction?.indicators?.macd === 'BULLISH' ? 'text-emerald-400' : state.aiPrediction?.indicators?.macd === 'BEARISH' ? 'text-red-400' : ''}>
              {state.aiPrediction?.indicators?.macd || "—"}
            </span>
          </div>
          <div>
            <span className="block text-[9px] text-gray-500">BOLLINGER</span>
            <span className={state.aiPrediction?.indicators?.bollinger === 'OVERBOUGHT' ? 'text-red-400' : state.aiPrediction?.indicators?.bollinger === 'OVERSOLD' ? 'text-emerald-400' : ''}>
              {state.aiPrediction?.indicators?.bollinger || "—"}
            </span>
          </div>
        </div>
      </div>



      {/* 4. Real-time Epoch Price Board: Lock Price, Open Price, Close Price */}
      <div id="epoch-price-monitor-card" className="col-span-1 md:col-span-2 xl:col-span-3 bg-[#0c111e]/90 border border-[#1f293d]/90 rounded-2xl p-5 backdrop-blur-md relative overflow-hidden mt-2">
        <div className="absolute top-0 left-0 w-full h-[1.5px] bg-gradient-to-r from-transparent via-sky-500/20 to-transparent" />
        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[#1f293d]/40 pb-4 gap-3">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-sky-400 animate-pulse" />
            <div>
              <h3 className="text-sm font-bold text-gray-200 font-display">Real-Time Epoch Price Monitor</h3>
              <p className="text-[10px] text-gray-400 font-mono">Continuous tracking of on-chain / simulated Lock Price, Open Price, and Close Price metrics</p>
            </div>
          </div>
          <span className="self-start sm:self-auto text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2.5 py-1 rounded-md font-mono font-bold tracking-wide uppercase">
            ● 8-Decimal Oracle Precision
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-5">
          {state.liveRounds && state.liveRounds.length > 0 ? (
            state.liveRounds.map((round) => {
              const isBidding = round.status === 'BIDDING';
              const isLive = round.status === 'LIVE';
              
              const priceDiff = round.closePrice - round.lockPrice;
              const hasWonBull = round.closePrice > round.lockPrice;
              const hasWonBear = round.lockPrice > round.closePrice;
              const isDraw = round.lockPrice === round.closePrice && round.lockPrice > 0;

              return (
                <div 
                  key={round.epoch}
                  id={`round-card-${round.epoch}`}
                  className={`border rounded-xl p-4 flex flex-col justify-between transition-all duration-300 bg-gray-950/40 ${
                    isBidding 
                      ? 'border-[#1f293d] hover:border-sky-500/40' 
                      : isLive 
                        ? 'border-emerald-500/30 hover:border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.06)]' 
                        : 'border-slate-800/40 hover:border-[#1f293d]'
                  }`}
                >
                  {/* Card Header section */}
                  <div className="flex justify-between items-center mb-3">
                    <span className="text-xs font-mono font-bold text-sky-300">
                      EPOCH #{round.epoch * 300}
                    </span>
                    <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono font-semibold ${
                      isBidding 
                        ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20' 
                        : isLive 
                          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 animate-pulse' 
                          : 'bg-gray-800/60 text-gray-400 border border-gray-700/30'
                    }`}>
                      {round.status}
                    </span>
                  </div>

                  {/* Prices breakdown */}
                  <div className="space-y-2.5 my-2.5">
                    {/* 1. Price to Beat section */}
                    <div className="flex justify-between items-center text-xs font-mono border-b border-[#1f293d]/30 pb-1.5">
                      <span className="text-gray-500 text-[11px] uppercase tracking-wider">Price to Beat</span>
                      <span className={`font-semibold font-mono ${isBidding ? 'text-gray-500 animate-pulse' : 'text-amber-400'}`}>
                        {round.lockPrice > 0 
                          ? `$${round.lockPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
                          : isBidding
                            ? `~$${state.btcPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : 'Waiting...'
                        }
                      </span>
                    </div>

                    {/* 2. Final / Real-time Price section */}
                    <div className="flex justify-between items-center text-xs font-mono pt-0.5">
                      <span className="text-gray-500 text-[11px] uppercase tracking-wider flex items-center gap-1">
                        {isLive && <Clock className="w-3 h-3 text-emerald-400 animate-spin" />}
                        {isLive ? 'Real-Time Price' : 'Final Price'}
                      </span>
                      <span className={`font-bold font-mono ${
                        isBidding 
                          ? 'text-gray-500' 
                          : isLive 
                            ? 'text-emerald-400 animate-pulse' 
                            : hasWonBull 
                              ? 'text-emerald-400' 
                              : hasWonBear 
                                ? 'text-red-400' 
                                : 'text-gray-300'
                      }`}>
                        {round.closePrice > 0 
                          ? `$${round.closePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
                          : isBidding 
                            ? '—' 
                            : '—'
                        }
                      </span>
                    </div>
                  </div>

                  {/* Outcome direction or status bar */}
                  <div className="mt-3 pt-3 border-t border-[#1f293d]/40 flex justify-between items-center text-[10px] font-mono">
                    <span className="text-gray-500">Epoch Outcome:</span>
                    {isBidding ? (
                      <span className="text-sky-400">Accepting bets...</span>
                    ) : isLive ? (
                      <span className={`font-semibold flex items-center gap-1 ${priceDiff >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {priceDiff >= 0 ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                        {priceDiff >= 0 ? 'BULL' : 'BEAR'} ({priceDiff >= 0 ? '+' : ''}{priceDiff.toFixed(2)})
                      </span>
                    ) : isDraw ? (
                      <span className="text-gray-400 font-semibold">DRAW (REFUNDED)</span>
                    ) : (
                      <span className={`font-bold flex items-center gap-1 ${hasWonBull ? 'text-emerald-400' : 'text-red-400'}`}>
                        {hasWonBull ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                        {hasWonBull ? 'BULL' : 'BEAR'} ({priceDiff >= 0 ? '+' : ''}{priceDiff.toFixed(2)})
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="col-span-1 md:col-span-3 text-center py-6 text-xs text-gray-500 font-mono">
              Loading real-time epoch round stages...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
