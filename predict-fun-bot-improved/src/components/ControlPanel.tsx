/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { SystemConfig } from "../types";
import { Settings2, ShieldCheck, HelpCircle, Save, ExternalLink } from "lucide-react";

interface ControlPanelProps {
  initialConfig: SystemConfig;
  onSave: (config: Partial<SystemConfig>) => Promise<boolean>;
  walletBalanceUsdt?: number;
  estimatedGasCostUsdt?: number;
}

export function ControlPanel({ initialConfig, onSave, walletBalanceUsdt, estimatedGasCostUsdt }: ControlPanelProps) {
  const [bscRpc, setBscRpc] = useState(initialConfig.bscRpc);
  const [walletPrivateKey, setWalletPrivateKey] = useState("");
  const [betAmountUsdt, setBetAmountUsdt] = useState(initialConfig.betAmountUsdt);
  const [minConfidence, setMinConfidence] = useState(initialConfig.minConfidence);
  const [minPriceMovePct, setMinPriceMovePct] = useState(initialConfig.minPriceMovePct ?? 0.02);
  const [isLiveTrading, setIsLiveTrading] = useState(initialConfig.isLiveTrading);
  const [maxDailyLossUsdt, setMaxDailyLossUsdt] = useState(initialConfig.maxDailyLossUsdt);
  const [simulateLiveBalances, setSimulateLiveBalances] = useState(initialConfig.simulateLiveBalances ?? true);
  const [biconomyBundlerUrl, setBiconomyBundlerUrl] = useState(initialConfig.biconomyBundlerUrl ?? "");
  const [biconomyPaymasterApiKey, setBiconomyPaymasterApiKey] = useState(initialConfig.biconomyPaymasterApiKey ?? "");
  const [cerebrasApiEndpoint, setCerebrasApiEndpoint] = useState(initialConfig.cerebrasApiEndpoint ?? "https://api.cerebras.ai/v1");
  const [cerebrasModel, setCerebrasModel] = useState(initialConfig.cerebrasModel ?? "gpt-oss-120b");
  const [brainPreset, setBrainPreset] = useState<'AGGRESSIVE_PRESET' | 'NORMAL_PRESET' | 'HYPER_PRESET'>(initialConfig.brainPreset ?? "AGGRESSIVE_PRESET");
  const [executionSlippage, setExecutionSlippage] = useState(initialConfig.executionSlippage ?? 0.03);
  const [predictSyncIntervalMs, setPredictSyncIntervalMs] = useState(initialConfig.predictSyncIntervalMs ?? 150);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'IDLE' | 'SUCCESS' | 'ERROR'>('IDLE');

  const handlePresetChange = (preset: 'AGGRESSIVE_PRESET' | 'NORMAL_PRESET' | 'HYPER_PRESET') => {
    setBrainPreset(preset);
    if (preset === 'AGGRESSIVE_PRESET') {
      setMinConfidence(0.51);
    } else if (preset === 'NORMAL_PRESET') {
      setMinConfidence(0.54);
    } else if (preset === 'HYPER_PRESET') {
      setMinConfidence(0.48);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveStatus('IDLE');

    const payload: Partial<SystemConfig> = {
      bscRpc,
      betAmountUsdt,
      minConfidence,
      minPriceMovePct,
      isLiveTrading,
      maxDailyLossUsdt,
      simulateLiveBalances,
      cerebrasApiEndpoint,
      cerebrasModel,
      brainPreset,
      biconomyBundlerUrl,
      biconomyPaymasterApiKey,
      executionSlippage,
      predictSyncIntervalMs
    };

    // Only update private key if they typed a valid private key length
    if (walletPrivateKey.trim().length === 66 && walletPrivateKey.trim().startsWith("0x")) {
      payload.walletPrivateKey = walletPrivateKey.trim().substring(2);
    } else if (walletPrivateKey.trim().length === 64) {
      payload.walletPrivateKey = walletPrivateKey.trim();
    }

    const success = await onSave(payload);
    setIsSaving(false);
    if (success) {
      setSaveStatus('SUCCESS');
      setWalletPrivateKey(""); // wipe input
      setTimeout(() => setSaveStatus('IDLE'), 4000);
    } else {
      setSaveStatus('ERROR');
    }
  };

  return (
    <div className="bg-[#0c111e]/80 border border-[#1f293d]/80 rounded-2xl p-6 backdrop-blur-md relative overflow-hidden">
      <div className="absolute right-0 bottom-0 w-32 h-32 bg-sky-500/5 rounded-full blur-3xl pointer-events-none" />
      
      <div className="flex items-center gap-2.5 pb-4 border-b border-[#1f293d]/60 mb-6Shared md:mb-5">
        <Settings2 className="w-5 h-5 text-sky-400" />
        <div>
          <h2 className="text-base font-semibold text-gray-200 font-display">Algorithmic Strategy Console</h2>
          <p className="text-xs text-gray-400">Set trade exposures, private key credentials, custom indicators thresholds, and trading node settings</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Trading Mode selector */}
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2 font-display">
            Execution Interface Mode
          </label>
          <div className="grid grid-cols-2 gap-3 p-1 bg-gray-950 border border-[#1f293d] rounded-xl">
            <button
              type="button"
              onClick={() => setIsLiveTrading(false)}
              className={`py-2 text-xs font-semibold rounded-lg font-display transition-all ${
                !isLiveTrading
                  ? 'bg-blue-600/20 border border-blue-500/30 text-blue-300 shadow-md'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              Paper trading (Simulation)
            </button>
            <button
              type="button"
              onClick={() => setIsLiveTrading(true)}
              className={`py-2 text-xs font-semibold rounded-lg font-display transition-all ${
                isLiveTrading
                  ? 'bg-red-600/20 border border-red-500/30 text-red-300 shadow-md animate-pulse-glow'
                  : 'text-gray-400 hover:text-gray-300'
              }`}
            >
              Live Trading (EVM Actions)
            </button>
          </div>
          <p className="text-[10px] text-gray-500 mt-1.5 leading-relaxed">
            {!isLiveTrading 
              ? "📈 Active paper-trading uses live Predict.fun contract sessions and Binance orderbook prices with instant simulated executions to construct precise performance metrics under zero risk."
              : "⚠️ Live trading issues transactions onto the on-chain BSC network. Make sure your wallet key is private, funded with USDT & BNB (for gas), and belongs to a DEDICATED trading address with minor volumes."
            }
          </p>

          {isLiveTrading && (
            <div className="mt-3.5 bg-sky-950/40 border border-sky-500/20 rounded-xl p-3.5 flex items-start justify-between gap-3">
              <div className="space-y-1">
                <span className="text-xs font-bold text-sky-300 font-display block">Simulated EVM Sandbox (Mock Funding Status)</span>
                <p className="text-[10px] text-gray-300 leading-relaxed font-sans">
                  Automatically sandbox transactions on live contract sessions. Allows you to test complete algorithmic on-chain logic, stream real-time epochs, and mock successful logs with zero actual gas/USDT risk.
                </p>
              </div>
              <input
                type="checkbox"
                checked={simulateLiveBalances}
                onChange={(e) => setSimulateLiveBalances(e.target.checked)}
                className="w-4 h-4 rounded border-gray-700 bg-gray-950 text-sky-500 focus:ring-sky-500 focus:ring-opacity-25 accent-sky-500 cursor-pointer mt-1"
              />
            </div>
          )}

          {isLiveTrading && walletBalanceUsdt !== undefined && (() => {
            if (simulateLiveBalances) {
              return (
                <div className="mt-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-[10px] text-emerald-300 font-mono">Sandbox Activated: Vault funded with <span className="font-bold">150.00 USDT</span> play tokens.</span>
                  </div>
                </div>
              );
            }
            const threshold = betAmountUsdt;
            return walletBalanceUsdt < threshold && (
              <div className="mt-3 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3.5 space-y-1.5 text-xs text-amber-200">
                <div className="flex items-center gap-2 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span>Vault Balance Alert</span>
                </div>
                <p className="text-[10px] text-gray-300 leading-relaxed font-sans">
                  Your vault address ({initialConfig.walletAddress ? <span className="font-mono font-bold text-amber-400">{initialConfig.walletAddress}</span> : "Not configured"}) holds <span className="font-mono font-bold text-amber-400">{walletBalanceUsdt.toFixed(2)} USDT</span>, which is less than the safe execution threshold of <span className="font-mono font-bold text-amber-400">{threshold.toFixed(2)} USDT</span> ({betAmountUsdt} USDT bet).
                </p>
                <p className="text-[10px] text-gray-400 leading-relaxed font-sans">
                  To prevent on-chain transaction failures, any live rounds triggered while underfunded will gracefully fall back to paper-trading. Fund your vault address with USDT to proceed.
                </p>
              </div>
            );
          })()}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* RPC Node */}
          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display">
              BNB Chain RPC API Node
            </label>
            <input
              type="text"
              value={bscRpc}
              onChange={(e) => setBscRpc(e.target.value)}
              required
              className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all"
              placeholder="e.g. https://bsc-dataseed.binance.org/"
            />
          </div>

          {/* Secure Private Key */}
          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display flex items-center justify-between">
              <span>Private Key (Stand-Alone EOA Bot Wallet)</span>
              <span className="text-[10px] text-amber-500 flex items-center gap-1 font-mono">
                <HelpCircle className="w-3.5 h-3.5" /> Secure storage
              </span>
            </label>
            <p className="text-[10px] text-gray-400 mb-2 leading-tight">Must be a standard wallet (MetaMask/Trust Wallet) containing USDT & BNB. <strong>Do not use</strong> the Predict.fun Account Abstraction Kernel address directly!</p>
            <input
              type="password"
              value={walletPrivateKey}
              onChange={(e) => setWalletPrivateKey(e.target.value)}
              className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all"
              placeholder={initialConfig.walletAddress ? "●●●●●● (Wiped. Type new key to override)" : "Type 64-character EVM Private Key"}
            />
            {initialConfig.walletAddress && (
              <div className="space-y-1 mt-1">
                <div className="flex justify-between items-center text-[10px] text-emerald-400 font-mono">
                  <span>Active Vault Address:</span>
                  <span className="font-semibold">{initialConfig.walletAddress}</span>
                </div>
                {walletBalanceUsdt !== undefined && (
                  <div className="flex justify-between items-center text-[10px] text-sky-400 font-mono">
                    <span>Vault Balance:</span>
                    <span className="font-bold">{walletBalanceUsdt.toFixed(2)} USDT</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full mt-4">
               <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display">
                    Biconomy Bundler URL (Optional)
                  </label>
                  <p className="text-[10px] text-gray-400 mb-2 leading-tight">Leave blank to use default public Pimlico bundler.</p>
                  <input
                    type="text"
                    value={biconomyBundlerUrl}
                    onChange={(e) => setBiconomyBundlerUrl(e.target.value)}
                    className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all"
                    placeholder="https://public.pimlico.io/v2/56/rpc"
                  />
               </div>
               <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display">
                    Biconomy Paymaster API Key (Optional)
                  </label>
                  <p className="text-[10px] text-gray-400 mb-2 leading-tight">If empty, Vault needs BNB for gas.</p>
                  <input
                    type="password"
                    value={biconomyPaymasterApiKey}
                    onChange={(e) => setBiconomyPaymasterApiKey(e.target.value)}
                    className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-gray-200 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all"
                    placeholder="Paymaster Key"
                  />
               </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-4">
            {/* Bet size */}
            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display">
                Bet Volume per Epoch (recom: 1.00 USDT)
              </label>
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="100"
                value={betAmountUsdt || ""}
                onChange={(e) => setBetAmountUsdt(parseFloat(e.target.value) || 0)}
                required
                className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-emerald-400 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all"
                placeholder="1.0"
              />
              {isLiveTrading && betAmountUsdt < 1.0 && (
                <span className="text-[10px] text-amber-400/90 leading-normal block mt-1">
                  ⚠️ Predict.fun accepts predictions using USDT.
                </span>
              )}
            </div>

            {/* Max daily exposure */}
            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display">
                Maximum Daily Drawdown Barrier (USDT)
              </label>
              <input
                type="number"
                step="0.5"
                min="0.1"
                value={maxDailyLossUsdt || ""}
                onChange={(e) => setMaxDailyLossUsdt(parseFloat(e.target.value) || 0)}
                required
                className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-red-400 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all relative"
                placeholder="5.0"
              />
            </div>
          </div>
        </div>

        {/* HFT Low-Latency & Sniper Settings */}
        <div className="bg-gray-950/60 p-4 border border-[#1f293d] rounded-xl space-y-4">
          <label className="block text-xs font-semibold text-sky-400 font-display uppercase tracking-wider">
            ⚡ Ultra-Low Latency & Front-Running Controls
          </label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Predict.fun Polling Interval */}
            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display">
                Predict.fun Price Polling Interval (ms)
              </label>
              <input
                type="number"
                step="25"
                min="50"
                max="1000"
                value={predictSyncIntervalMs}
                onChange={(e) => setPredictSyncIntervalMs(parseInt(e.target.value) || 150)}
                required
                className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-sky-300 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all"
                placeholder="150"
              />
              <span className="text-[10px] text-gray-500 mt-1 block leading-relaxed">
                Non-overlapping delay (default 150ms). Keeps options pricing synchronized for front-running.
              </span>
            </div>

            {/* Execution Slippage Tolerance */}
            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1.5 font-display">
                LIMIT BUY Slippage Tolerance (%)
              </label>
              <input
                type="number"
                step="1"
                min="1"
                max="50"
                value={Math.round(executionSlippage * 100)}
                onChange={(e) => setExecutionSlippage((parseFloat(e.target.value) || 12) / 100)}
                required
                className="w-full bg-gray-950/80 border border-[#1f293d] rounded-xl px-3.5 py-2 text-xs text-amber-400 font-mono focus:outline-none focus:ring-1 focus:ring-sky-500 transition-all"
                placeholder="12"
              />
              <span className="text-[10px] text-gray-500 mt-1 block leading-relaxed">
                Generous limit price markup (default 12%) to sweep available asks instantly and beat other bots.
              </span>
            </div>
          </div>
        </div>

        {/* v5.1 Aggressive Edition Presets Selection */}
        <div className="bg-gray-950/60 p-4 border border-[#1f293d] rounded-xl space-y-3">
          <label className="block text-xs font-semibold text-gray-300 font-display">
            🧠 v5.1 Aggressive Edition Core Presets
          </label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* AGGRESSIVE_PRESET */}
            <div 
              onClick={() => handlePresetChange('AGGRESSIVE_PRESET')}
              className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between ${
                brainPreset === 'AGGRESSIVE_PRESET' 
                  ? 'border-emerald-500 bg-emerald-950/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]' 
                  : 'border-[#1f293d] bg-gray-900/40 hover:border-gray-700'
              }`}
            >
              <div>
                <span className="text-[10px] font-bold text-emerald-400 font-mono tracking-wider block mb-1">AGGRESSIVE</span>
                <span className="text-xs font-semibold text-gray-200 block">v5.1 Aggressive</span>
              </div>
              <div className="mt-2.5 space-y-1 text-[10px] text-gray-400 font-mono">
                <div>• Threshold: <span className="text-emerald-300 font-bold">51%</span></div>
                <div>• Guards: <span className="text-emerald-400 font-bold">MUTED</span></div>
                <div>• Auto Pause: <span className="text-gray-300 font-semibold text-emerald-400">DISABLED</span></div>
              </div>
            </div>

            {/* NORMAL_PRESET */}
            <div 
              onClick={() => handlePresetChange('NORMAL_PRESET')}
              className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between ${
                brainPreset === 'NORMAL_PRESET' 
                  ? 'border-sky-500 bg-sky-950/20 shadow-[0_0_12px_rgba(14,165,233,0.15)]' 
                  : 'border-[#1f293d] bg-gray-900/40 hover:border-gray-700'
              }`}
            >
              <div>
                <span className="text-[10px] font-bold text-sky-400 font-mono tracking-wider block mb-1">NORMAL</span>
                <span className="text-xs font-semibold text-gray-200 block">Standard Safe</span>
              </div>
              <div className="mt-2.5 space-y-1 text-[10px] text-gray-400 font-mono">
                <div>• Threshold: <span className="text-sky-300 font-bold">54%</span></div>
                <div>• Guards: <span className="text-sky-400 font-bold">STANDARD</span></div>
                <div>• Auto Pause: <span className="text-gray-300 font-semibold text-sky-400">DISABLED</span></div>
              </div>
            </div>

            {/* HYPER_PRESET */}
            <div 
              onClick={() => handlePresetChange('HYPER_PRESET')}
              className={`p-3 rounded-xl border cursor-pointer transition-all flex flex-col justify-between ${
                brainPreset === 'HYPER_PRESET' 
                  ? 'border-[#f43f5e] bg-rose-950/20 shadow-[0_0_12px_rgba(244,63,94,0.15)]' 
                  : 'border-[#1f293d] bg-gray-900/40 hover:border-gray-700'
              }`}
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-rose-400 font-mono tracking-wider">HYPER</span>
                  <span className="text-[8px] bg-rose-500/20 text-rose-300 px-1 rounded border border-rose-500/30 font-display">⚠️ HIGH RISK</span>
                </div>
                <span className="text-xs font-semibold text-gray-200 block mt-0.5 font-display">Maximum Yield</span>
              </div>
              <div className="mt-2.5 space-y-1 text-[10px] text-gray-400 font-mono">
                <div>• Threshold: <span className="text-rose-300 font-bold">48%</span></div>
                <div>• Guards: <span className="text-rose-400 font-bold">MUTED</span></div>
                <div>• Auto Pause: <span className="text-gray-300 font-semibold text-rose-400">DISABLED</span></div>
              </div>
            </div>
          </div>
        </div>

        {/* Slider for confidence indicator threshold */}
        <div className="bg-gray-950/60 p-4 border border-[#1f293d] rounded-xl">
          <div className="flex justify-between items-center mb-1.5 text-xs text-gray-300">
            <span className="font-semibold font-display">Minimum AI Confirmation Threshold</span>
            <span className="font-mono font-bold text-sky-400">{(minConfidence * 100).toFixed(0)}%</span>
          </div>
          <input
            type="range"
            min="0.45"
            max="0.95"
            step="0.01"
            value={minConfidence}
            onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-gray-900 rounded-lg appearance-none cursor-pointer accent-sky-500"
          />
          <span className="text-[10px] text-gray-500 leading-relaxed block mt-1.5 font-sans">
            Predictions scoring lower than this threshold are marked as "HOLD" (no-trade orders) to defensively manage trade risk. Highly conservative systems use 70%+ values.
          </span>
        </div>

        {/* Slider for price delta movement threshold */}
        <div className="bg-gray-950/60 p-4 border border-[#1f293d] rounded-xl">
          <div className="flex justify-between items-center mb-1.5 text-xs text-gray-300">
            <span className="font-semibold font-display">Minimum Instant Price Move Threshold</span>
            <span className="font-mono font-bold text-sky-400">{minPriceMovePct}%</span>
          </div>
          <input
            type="range"
            min="0.005"
            max="0.050"
            step="0.001"
            value={minPriceMovePct}
            onChange={(e) => setMinPriceMovePct(parseFloat(e.target.value))}
            className="w-full h-1.5 bg-gray-900 rounded-lg appearance-none cursor-pointer accent-sky-500"
          />
          <span className="text-[10px] text-gray-500 leading-relaxed block mt-1.5 font-sans">
            Minimal instant price movement (in percentage) within the 50ms detection window needed to trigger sniper execution. Lowering this to 0.02% or less increases trade frequency and aggression, while higher values (e.g. 0.03%) are more conservative.
          </span>
        </div>

        {/* Form Action buttons */}
        <div className="flex items-center justify-between pt-2">
          {saveStatus === 'SUCCESS' && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono font-semibold animate-pulse">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Settings updated successfully!</span>
            </div>
          )}
          {saveStatus === 'ERROR' && (
            <span className="text-xs text-red-400 font-mono font-semibold">
              Save failed. Check network or key structure.
            </span>
          )}
          <div className="flex-1" />
          <button
            type="submit"
            disabled={isSaving}
            className="bg-sky-600 hover:bg-sky-700 text-white font-medium font-display text-xs px-5 py-2.5 rounded-xl transition-all shadow-md flex items-center gap-2 hover:scale-[1.02] cursor-pointer disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            {isSaving ? "Saving Config..." : "Activate Strategy Configuration"}
          </button>
        </div>
      </form>
    </div>
  );
}
