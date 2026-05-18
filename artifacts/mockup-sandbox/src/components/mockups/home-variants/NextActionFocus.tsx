import React from "react";
import { ChevronRight, AlertTriangle, CheckSquare, FileText, Calendar } from "lucide-react";

export function NextActionFocus() {
  const currentDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="w-full h-full min-h-screen bg-[#200842] text-[#F6F1E7] flex justify-center items-start overflow-auto font-sans" style={{ fontFamily: 'Open Sans, sans-serif' }}>
      <div className="w-full max-w-[390px] mx-auto p-4 flex flex-col gap-6">
        
        {/* Header */}
        <header className="pt-8 pb-2">
          <p className="text-xs text-[#F6F1E7]/60 font-semibold tracking-wider uppercase mb-1">{currentDate}</p>
          <h1 className="text-3xl font-bold tracking-tight">Good morning, Harry</h1>
        </header>

        {/* Hero Card */}
        <section>
          <div className="bg-[#8B2BFF]/15 border border-[#8B2BFF]/30 rounded-3xl p-6 relative overflow-hidden group cursor-pointer active:scale-[0.98] transition-transform">
            <div className="absolute top-0 left-0 w-2 h-full bg-[#8B2BFF]"></div>
            
            <div className="flex items-center justify-between mb-5">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider bg-red-500/20 text-red-400 border border-red-500/30">
                <AlertTriangle className="w-3.5 h-3.5" />
                Overdue Task
              </span>
            </div>

            <h2 className="text-2xl font-extrabold leading-tight mb-3 pr-4">Measure kitchen units – Mrs Patterson</h2>
            <p className="text-sm font-medium text-[#F6F1E7]/80 flex items-center gap-2">
              Overdue by 2 days · Tap to open tasks
            </p>
          </div>
        </section>

        {/* Summary Rows */}
        <section className="flex flex-col gap-3 mt-2">
          
          {/* Tasks Row */}
          <button className="w-full flex items-center justify-between p-4 rounded-2xl bg-white/[0.04] border border-white/5 active:bg-white/[0.08] transition-colors text-left group">
            <div className="flex items-center gap-4">
              <div className="p-2.5 rounded-xl bg-white/10 text-white/90 group-active:scale-95 transition-transform">
                <CheckSquare className="w-5 h-5" />
              </div>
              <div>
                <p className="font-semibold text-base">3 tasks · 2 overdue</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-white/30" />
          </button>

          {/* Invoices Row */}
          <button className="w-full flex items-center justify-between p-4 rounded-2xl bg-white/[0.04] border border-white/5 active:bg-white/[0.08] transition-colors text-left group">
            <div className="flex items-center gap-4">
              <div className="p-2.5 rounded-xl bg-white/10 text-white/90 group-active:scale-95 transition-transform">
                <FileText className="w-5 h-5" />
              </div>
              <div>
                <p className="font-semibold text-base">£2,480 overdue invoices</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-white/30" />
          </button>

          {/* Calendar Row */}
          <button className="w-full flex items-center justify-between p-4 rounded-2xl bg-white/[0.04] border border-white/5 active:bg-white/[0.08] transition-colors text-left group">
            <div className="flex items-center gap-4">
              <div className="p-2.5 rounded-xl bg-white/10 text-white/90 group-active:scale-95 transition-transform">
                <Calendar className="w-5 h-5" />
              </div>
              <div>
                <p className="font-semibold text-base leading-tight">Survey at 42 Elm St</p>
                <p className="text-sm text-[#F6F1E7]/60 mt-1">10:00 today</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-white/30" />
          </button>

        </section>

      </div>
    </div>
  );
}
