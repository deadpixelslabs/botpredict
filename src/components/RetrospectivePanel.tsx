import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Sparkles, RefreshCcw, HelpCircle, AlertTriangle, ShieldCheck, TrendingUp, Lightbulb } from "lucide-react";

export interface RetrospectiveReport {
  lastUpdated: string;
  totalAnalysed: number;
  lossesCount: number;
  winsCount: number;
  failureAnalysis: string;
  reversalReason: string;
  dynamicRules: {
    emaDiffVelLimit: number;      
    stochExtLimit: number;        
    obPressureThreshold: number;  
    divergenceVetoThreshold: number;
    regimeBiasAdjustments: Record<string, number>; 
  };
  reversalVetoActive: boolean;
  systemTips: string[];
}

export function RetrospectivePanel() {
  const [report, setReport] = useState<RetrospectiveReport | null>(null);
  const [isStudying, setIsStudying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fetchReport = async () => {
    try {
      const res = await fetch("/api/retrospective");
      const data = await res.json();
      if (data && data.lastUpdated) {
        setReport(data);
        setErrorMessage(null);
      } else {
        setReport(null);
      }
    } catch (e) {
      console.warn("Failed to fetch AI retrospective data:", e);
    }
  };

  const triggerStudy = async () => {
    setIsStudying(true);
    setErrorMessage(null);
    try {
      const res = await fetch("/api/retrospective/trigger", { method: "POST" });
      const data = await res.json();
      if (data && data.success && data.report) {
        setReport(data.report);
      } else {
        setErrorMessage("Insufficient settlement history to run a feedback model. Try placing a few trades first!");
      }
    } catch (e: any) {
      setErrorMessage("Service is temporarily busy. Check backend logs.");
    } finally {
      setIsStudying(false);
    }
  };

  useEffect(() => {
    fetchReport();
    // Refresh every 10 seconds to sync changes automatically
    const timer = setInterval(fetchReport, 10500);
    return () => clearInterval(timer);
  }, []);

  return (
    <div id="ai-cognitive-retro-panel" className="bg-[#0b1224] border border-[#1f293d]/60 rounded-2xl p-5 shadow-[0_8px_32px_rgba(3,7,18,0.4)] relative overflow-hidden">
      {/* Decorative ambient gradient backing */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-sky-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-[#1f293d]/50 pb-4 gap-4 mb-5">
        <div className="flex items-center gap-2.5">
          <div className="bg-sky-500/10 p-2 rounded-xl text-sky-400 border border-sky-500/20 shadow-[0_0_15px_rgba(56,189,248,0.15)] flex items-center justify-center">
            <Sparkles className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h3 className="text-sm font-extrabold text-gray-100 tracking-wide uppercase font-display flex items-center gap-1.5">
              AI Brain Cognitive Learning Hub
            </h3>
            <p className="text-[10px] text-gray-400 font-mono tracking-tight leading-normal">
              Dynamically reviews losses and auto-calibrates indicators & veto settings
            </p>
          </div>
        </div>

        <button
          onClick={triggerStudy}
          disabled={isStudying}
          className={`px-4 py-2 rounded-xl font-display text-[10px] font-bold tracking-wider uppercase transition-all duration-300 border flex items-center gap-1.5 cursor-pointer select-none ${
            isStudying
              ? "bg-sky-950/40 border-sky-500/20 text-gray-400 cursor-not-allowed"
              : "bg-sky-500/10 hover:bg-sky-500/18 border-sky-500/30 hover:border-sky-500/50 text-sky-400 active:scale-95"
          }`}
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${isStudying ? "animate-spin" : ""}`} />
          {isStudying ? "Analyzing logs..." : "Trigger AI Post-Mortem Audit"}
        </button>
      </div>

      {/* Error Info / Missing Data states */}
      {errorMessage && (
        <div className="bg-amber-500/10 border border-amber-500/20 p-3 rounded-xl mb-4 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-[10px] text-amber-200 leading-normal">
            <span className="font-bold uppercase font-display block mb-0.5">Insufficient Trade Logs</span>
            {errorMessage}
          </div>
        </div>
      )}

      {!report ? (
        <div className="bg-[#070b16] border border-[#1f293d]/40 rounded-xl p-8 text-center text-gray-500">
          <HelpCircle className="w-8 h-8 text-sky-500/20 mx-auto mb-2.5" />
          <p className="text-[11px] font-display text-gray-300">No active cognitive rule weights written yet.</p>
          <p className="text-[10px] text-gray-500 font-mono mt-1 max-w-md mx-auto">
            The AI learns from trade outcomes in real-time. Once at least three trade rounds are WON, LOST, or SKIPPED, the retrospective optimizer will automatically calibrate or you can click the button above!
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          
          {/* Top Info Banner - Quick Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#070b16] border border-[#1f293d]/50 p-3 rounded-xl">
            <div className="text-center font-mono">
              <span className="text-[9px] text-gray-500 block uppercase font-display">Last Learning Scan</span>
              <span className="text-[10px] text-sky-400 font-bold block mt-0.5">
                {new Date(report.lastUpdated).toLocaleTimeString()}
              </span>
            </div>
            <div className="text-center font-mono">
              <span className="text-[9px] text-gray-500 block uppercase font-display">Epochs Audited</span>
              <span className="text-[10px] text-white font-bold block mt-0.5">{report.totalAnalysed}</span>
            </div>
            <div className="text-center font-mono">
              <span className="text-[9px] text-gray-500 block uppercase font-display">Analyzed Losses</span>
              <span className="text-[10px] text-rose-400 font-semibold block mt-0.5">{report.lossesCount}</span>
            </div>
            <div className="text-center font-mono">
              <span className="text-[9px] text-gray-500 block uppercase font-display">Learning Status</span>
              <span className="text-[10px] text-emerald-400 font-semibold flex items-center justify-center gap-1 mt-0.5">
                <ShieldCheck className="w-3.5 h-3.5" /> Active Overlay
              </span>
            </div>
          </div>

          {/* Double Column Breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            
            {/* Column A: Synthesized Post-Mortem Reviews */}
            <div className="space-y-3.5">
              <div className="bg-[#070b16]/70 border border-[#1f293d]/40 p-4 rounded-xl space-y-2.5 h-full">
                <div className="flex items-center gap-2 text-rose-400 border-b border-[#1f293d]/40 pb-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-extrabold uppercase font-display tracking-wider">Failure Risk Analysis</span>
                </div>
                <p className="text-[10px] text-gray-300 leading-normal font-sans italic">
                  "{report.failureAnalysis}"
                </p>

                <div className="flex items-center gap-2 text-amber-400 border-b border-[#1f293d]/40 pt-2 pb-1.5">
                  <TrendingUp className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-extrabold uppercase font-display tracking-wider">Why Reversals Occurred</span>
                </div>
                <p className="text-[10px] text-gray-300 leading-normal font-sans">
                  {report.reversalReason}
                </p>
              </div>
            </div>

            {/* Column B: Dynamic Indicator Safeguard Rules */}
            <div className="space-y-3.5">
              <div className="bg-[#070b16]/70 border border-[#1f293d]/40 p-4 rounded-xl space-y-3 h-full">
                <div className="flex items-center gap-2 text-emerald-400 border-b border-[#1f293d]/40 pb-1.5">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span className="text-[10px] font-extrabold uppercase font-display tracking-wider">Calibrated Parameter Overlays</span>
                </div>

                <div className="grid grid-cols-2 gap-3.5">
                  <div className="bg-gray-950/60 border border-[#1f293d]/40 p-2.5 rounded-lg text-center">
                    <span className="text-[8px] text-gray-500 block uppercase font-mono">1m Pullback Speed Limit</span>
                    <span className="text-[11px] font-semibold text-sky-400 block font-mono mt-0.5">
                      {report.dynamicRules.emaDiffVelLimit.toFixed(2)}
                    </span>
                    <span className="text-[8px] text-gray-600 block mt-0.5">Short momentum velocity</span>
                  </div>

                  <div className="bg-gray-950/60 border border-[#1f293d]/40 p-2.5 rounded-lg text-center">
                    <span className="text-[8px] text-gray-500 block uppercase font-mono">Stoch Extreme Veto Floor</span>
                    <span className="text-[11px] font-semibold text-amber-400 block font-mono mt-0.5">
                      {report.dynamicRules.stochExtLimit.toFixed(2)}
                    </span>
                    <span className="text-[8px] text-gray-600 block mt-0.5">For reversal verification</span>
                  </div>

                  <div className="bg-gray-950/60 border border-[#1f293d]/40 p-2.5 rounded-lg text-center">
                    <span className="text-[8px] text-gray-500 block uppercase font-mono">Orderbook Pressure Min</span>
                    <span className="text-[11px] font-semibold text-teal-400 block font-mono mt-0.5">
                      {report.dynamicRules.obPressureThreshold.toFixed(2)}
                    </span>
                    <span className="text-[8px] text-gray-600 block mt-0.5">Order flow imbalance</span>
                  </div>

                  <div className="bg-gray-950/60 border border-[#1f293d]/40 p-2.5 rounded-lg text-center">
                    <span className="text-[8px] text-gray-500 block uppercase font-mono">Divergence Gate</span>
                    <span className="text-[11px] font-semibold text-indigo-400 block font-mono mt-0.5">
                      {report.dynamicRules.divergenceVetoThreshold.toFixed(2)}
                    </span>
                    <span className="text-[8px] text-gray-600 block mt-0.5">Divergence confirmation index</span>
                  </div>
                </div>

                {/* Regime biases */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-[8px] text-gray-500 block uppercase font-display tracking-wider">Regime Probability Bias Offsets</span>
                  <div className="grid grid-cols-4 gap-1.5">
                    {Object.entries((report.dynamicRules.regimeBiasAdjustments || {}) as Record<string, number>).map(([regimeName, val]) => (
                      <div key={regimeName} className="bg-gray-950/40 p-1.5 rounded text-center border border-[#1f293d]/30">
                        <span className="text-[7px] text-gray-400 block truncate uppercase font-mono">{regimeName.replace("_TREND", "")}</span>
                        <span className={`text-[9px] font-bold font-mono ${val >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {val >= 0 ? `+${val.toFixed(3)}` : val.toFixed(3)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            </div>

          </div>

          {/* System Tips Block */}
          <div className="bg-sky-500/5 border border-sky-500/10 p-3 rounded-xl flex items-start gap-2.5">
            <Lightbulb className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            <div className="text-[10px] text-gray-300 leading-normal space-y-1">
              <span className="font-extrabold uppercase font-display text-sky-400 block">Synthesized Operational Guidance</span>
              <ul className="list-disc list-inside space-y-0.5 text-gray-400 font-mono">
                {report.systemTips.map((tip, idx) => (
                  <li key={idx}>{tip}</li>
                ))}
              </ul>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
