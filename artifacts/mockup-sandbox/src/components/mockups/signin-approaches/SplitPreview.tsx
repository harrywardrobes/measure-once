import React from "react";
import { CheckCircle2, Clock, CalendarDays, ChevronRight, AlertCircle, FileText, Briefcase } from "lucide-react";

export function SplitPreview() {
  return (
    <div className="min-h-[100dvh] w-full max-w-[440px] mx-auto bg-[#F6F1E7] flex flex-col font-sans relative overflow-hidden">
      
      {/* Product Preview Zone (Top ~55%) */}
      <div className="relative h-[55dvh] w-full overflow-hidden select-none pointer-events-none">
        {/* Desaturation & Fade Overlay */}
        <div className="absolute inset-0 z-10 bg-gradient-to-b from-transparent via-[#F6F1E7]/40 to-[#F6F1E7] backdrop-blur-[1px]"></div>
        
        {/* Faux Dashboard Content */}
        <div className="absolute inset-0 p-5 flex flex-col gap-6 opacity-70 scale-95 origin-top">
          {/* Header */}
          <div className="flex justify-between items-end mt-4">
            <div>
              <p className="text-[#200842]/60 text-xs font-medium mb-1 uppercase tracking-wider">Today's Pipeline</p>
              <h2 className="text-[#200842] text-xl font-bold tracking-tight">18 May 2026</h2>
            </div>
            <div className="w-8 h-8 rounded-full bg-[#8B2BFF]/10 flex items-center justify-center text-[#8B2BFF] text-xs font-bold border border-[#8B2BFF]/20">
              HW
            </div>
          </div>

          {/* Activity Strip */}
          <div className="flex gap-3">
            <div className="bg-white/60 p-3 rounded-xl border border-[#200842]/5 flex-1 flex flex-col items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-[#200842]/40 mb-1" />
              <span className="text-sm font-bold text-[#200842]">3</span>
              <span className="text-[10px] text-[#200842]/50 uppercase">Tasks</span>
            </div>
            <div className="bg-white/60 p-3 rounded-xl border border-[#200842]/5 flex-1 flex flex-col items-center justify-center">
              <CalendarDays className="w-5 h-5 text-[#200842]/40 mb-1" />
              <span className="text-sm font-bold text-[#200842]">2</span>
              <span className="text-[10px] text-[#200842]/50 uppercase">Events</span>
            </div>
            <div className="bg-white/60 p-3 rounded-xl border border-[#200842]/5 flex-1 flex flex-col items-center justify-center">
              <FileText className="w-5 h-5 text-[#200842]/40 mb-1" />
              <span className="text-sm font-bold text-[#200842]">£2.4k</span>
              <span className="text-[10px] text-[#200842]/50 uppercase">Due</span>
            </div>
          </div>

          {/* Task List Snippet */}
          <div className="flex flex-col gap-2.5 mt-2">
            <div className="bg-white/80 p-3 rounded-xl border border-[#200842]/5 flex gap-3 items-start">
              <div className="mt-0.5 w-4 h-4 rounded-full border-2 border-[#dc2626]/30 flex-shrink-0"></div>
              <div>
                <p className="text-sm font-semibold text-[#200842] leading-tight">Measure kitchen units</p>
                <p className="text-xs text-[#200842]/60 mt-0.5">Mrs Patel · Bromley</p>
              </div>
            </div>
            
            <div className="bg-white/80 p-3 rounded-xl border border-[#200842]/5 flex gap-3 items-start">
              <div className="mt-0.5 w-4 h-4 rounded-full border-2 border-[#200842]/20 flex-shrink-0"></div>
              <div>
                <p className="text-sm font-semibold text-[#200842] leading-tight">Submit survey report</p>
                <p className="text-xs text-[#200842]/60 mt-0.5">Lewis kitchen island</p>
              </div>
            </div>

            <div className="bg-white/80 p-3 rounded-xl border border-[#200842]/5 flex gap-3 items-center">
              <div className="w-8 h-8 rounded-full bg-[#8B2BFF]/10 flex items-center justify-center text-[#8B2BFF] flex-shrink-0">
                <Briefcase className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-[#200842] leading-tight">Thompson Bedroom</p>
                <span className="inline-block mt-1 px-1.5 py-0.5 bg-[#8B2BFF]/10 text-[#8B2BFF] text-[9px] font-bold uppercase rounded-sm">Fitting</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Auth Panel Zone (Bottom ~45%) */}
      <div className="flex-1 flex flex-col justify-end px-8 pb-12 relative z-20">
        <div className="flex flex-col items-center text-center">
          {/* Logo Mark */}
          <div className="mb-4">
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="8" y="4" width="24" height="32" rx="2" stroke="#200842" strokeWidth="2.5"/>
              <line x1="12" y1="12" x2="16" y2="12" stroke="#200842" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="12" y1="20" x2="20" y2="20" stroke="#200842" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="12" y1="28" x2="16" y2="28" stroke="#200842" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
          </div>

          <h1 className="text-[2.5rem] leading-none mb-3 text-[#200842]" style={{ fontFamily: "'Anton', sans-serif", letterSpacing: "0.02em" }}>
            MEASURE ONCE
          </h1>
          
          <p className="text-[0.95rem] text-[#200842]/70 mb-8 font-medium">
            Sign in to step inside.
          </p>

          <div className="w-full flex flex-col gap-4">
            <button className="w-full bg-[#200842] hover:bg-[#2a0b57] text-white rounded-xl py-4 px-4 flex items-center justify-center gap-3 transition-colors active:scale-[0.98]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4H10V10H4V4Z" fill="currentColor"/>
                <path d="M14 4H20V10H14V4Z" fill="currentColor"/>
                <path d="M14 14H20V20H14V14Z" fill="currentColor"/>
                <path d="M4 14H10V20H4V14Z" fill="currentColor"/>
              </svg>
              <span className="font-semibold text-[0.95rem]">Sign in with Replit</span>
            </button>

            <a href="#" onClick={(e) => e.preventDefault()} className="text-sm font-medium text-[#200842]/60 hover:text-[#8B2BFF] transition-colors">
              Request access
            </a>
          </div>
        </div>
      </div>

    </div>
  );
}
