import React from 'react';
import { CheckCircle2, Clock, Calendar, FileText, Briefcase, ChevronRight, AlertCircle, CalendarDays, ClipboardList } from 'lucide-react';

export function WarmEditorial() {
  return (
    <div className="min-h-[100dvh] w-full max-w-[390px] mx-auto overflow-hidden flex flex-col font-sans" style={{ backgroundColor: '#F6F1E7', color: '#200842' }}>
      
      {/* Header */}
      <header className="px-5 pt-12 pb-6 flex flex-col gap-1">
        <h1 className="text-[1.8rem] font-[800] tracking-tight leading-none text-[#200842]">
          Monday
        </h1>
        <div className="flex items-center gap-2 mt-1">
          <p className="text-[0.95rem] text-[#200842]/60 font-medium">18 May 2026</p>
          <div className="w-1.5 h-1.5 rounded-full bg-[#8B2BFF]" />
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto px-5 pb-12 flex flex-col gap-8">
        
        {/* My Tasks */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-[0.68rem] font-[700] uppercase tracking-[0.08em] text-[#200842]/50 shrink-0">
              My Tasks
            </h2>
            <div className="h-px bg-[#200842]/10 flex-1"></div>
            <a href="#" className="text-[0.72rem] font-[700] text-[#8B2BFF] shrink-0">
              See all
            </a>
          </div>

          <div className="flex flex-col gap-3">
            {/* Overdue Task */}
            <div className="bg-[#FDFCFA] rounded-xl p-4 flex gap-3 items-start" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="mt-0.5">
                <div className="w-5 h-5 rounded-full border-2 border-[#dc2626]/40 flex items-center justify-center bg-[#fee2e2]">
                  <AlertCircle className="w-3 h-3 text-[#dc2626]" />
                </div>
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                  Measure kitchen units – Mrs Patterson
                </h3>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[0.67rem] font-[700] bg-[#fef2f2] text-[#b91c1c] w-fit">
                  Overdue
                </span>
              </div>
            </div>

            {/* Overdue Task */}
            <div className="bg-[#FDFCFA] rounded-xl p-4 flex gap-3 items-start" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="mt-0.5">
                <div className="w-5 h-5 rounded-full border-2 border-[#dc2626]/40 flex items-center justify-center bg-[#fee2e2]">
                  <AlertCircle className="w-3 h-3 text-[#dc2626]" />
                </div>
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                  Submit survey report
                </h3>
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[0.67rem] font-[700] bg-[#fef2f2] text-[#b91c1c] w-fit">
                  Overdue
                </span>
              </div>
            </div>

            {/* Due Today */}
            <div className="bg-[#FDFCFA] rounded-xl p-4 flex gap-3 items-start" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="mt-0.5">
                <div className="w-5 h-5 rounded-full border-2 border-[#200842]/20" />
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                  Site visit – Whitmore Road
                </h3>
                <p className="text-[0.75rem] text-[#200842]/60">Due today</p>
              </div>
            </div>

            {/* Due Today */}
            <div className="bg-[#FDFCFA] rounded-xl p-4 flex gap-3 items-start" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="mt-0.5">
                <div className="w-5 h-5 rounded-full border-2 border-[#200842]/20" />
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                  Call supplier re: hinges
                </h3>
                <p className="text-[0.75rem] text-[#200842]/60">Due today</p>
              </div>
            </div>
          </div>
        </section>

        {/* Upcoming */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-[0.68rem] font-[700] uppercase tracking-[0.08em] text-[#200842]/50 shrink-0">
              Upcoming
            </h2>
            <div className="h-px bg-[#200842]/10 flex-1"></div>
            <a href="#" className="text-[0.72rem] font-[700] text-[#8B2BFF] shrink-0">
              See all
            </a>
          </div>

          <div className="flex flex-col gap-3">
            <div className="bg-[#FDFCFA] rounded-xl p-4 flex gap-3 items-center" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="w-10 h-10 rounded-full bg-[#8B2BFF]/10 flex items-center justify-center shrink-0 text-[#8B2BFF]">
                <CalendarDays className="w-5 h-5" />
              </div>
              <div className="flex-1 flex flex-col">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                  Survey – 42 Elm Street
                </h3>
                <p className="text-[0.75rem] text-[#200842]/60 mt-0.5">Mon 18 May · 10:00</p>
              </div>
            </div>

            <div className="bg-[#FDFCFA] rounded-xl p-4 flex gap-3 items-center" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="w-10 h-10 rounded-full bg-[#200842]/5 flex items-center justify-center shrink-0 text-[#200842]/60">
                <Clock className="w-5 h-5" />
              </div>
              <div className="flex-1 flex flex-col">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                  Team standup
                </h3>
                <p className="text-[0.75rem] text-[#200842]/60 mt-0.5">Today · 14:30</p>
              </div>
            </div>
          </div>
        </section>

        {/* Overdue Invoices */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-[0.68rem] font-[700] uppercase tracking-[0.08em] text-[#200842]/50 shrink-0">
              Overdue Invoices
            </h2>
            <div className="h-px bg-[#200842]/10 flex-1"></div>
            <a href="#" className="text-[0.72rem] font-[700] text-[#8B2BFF] shrink-0">
              See all
            </a>
          </div>

          <div className="flex flex-col gap-3">
            <div className="bg-[#FDFCFA] rounded-xl p-4 flex items-center justify-between" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#fef2f2] flex items-center justify-center shrink-0 text-[#b91c1c]">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="flex flex-col">
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                    Harrison & Co
                  </h3>
                  <p className="text-[0.75rem] text-[#b91c1c] font-medium mt-0.5">Overdue</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[0.95rem] font-[700] text-[#200842]">£1,240</p>
              </div>
            </div>

            <div className="bg-[#FDFCFA] rounded-xl p-4 flex items-center justify-between" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#fef2f2] flex items-center justify-center shrink-0 text-[#b91c1c]">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="flex flex-col">
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                    Bradley Interiors
                  </h3>
                  <p className="text-[0.75rem] text-[#b91c1c] font-medium mt-0.5">Overdue</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[0.95rem] font-[700] text-[#200842]">£880</p>
              </div>
            </div>
          </div>
        </section>

        {/* Active Projects */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <h2 className="text-[0.68rem] font-[700] uppercase tracking-[0.08em] text-[#200842]/50 shrink-0">
              Active Projects
            </h2>
            <div className="h-px bg-[#200842]/10 flex-1"></div>
            <a href="#" className="text-[0.72rem] font-[700] text-[#8B2BFF] shrink-0">
              See all
            </a>
          </div>

          <div className="flex flex-col gap-3">
            <div className="bg-[#FDFCFA] rounded-xl p-4 flex flex-col gap-3" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#200842]/5 flex items-center justify-center shrink-0 text-[#200842]">
                    <Briefcase className="w-4 h-4" />
                  </div>
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                    Davies Bedroom
                  </h3>
                </div>
                <ChevronRight className="w-4 h-4 text-[#200842]/30" />
              </div>
              <div className="pl-11">
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[0.67rem] font-[700] bg-[#8B2BFF]/10 text-[#8B2BFF]">
                  Measuring
                </span>
              </div>
            </div>

            <div className="bg-[#FDFCFA] rounded-xl p-4 flex flex-col gap-3" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#200842]/5 flex items-center justify-center shrink-0 text-[#200842]">
                    <Briefcase className="w-4 h-4" />
                  </div>
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                    Thompson Kitchen
                  </h3>
                </div>
                <ChevronRight className="w-4 h-4 text-[#200842]/30" />
              </div>
              <div className="pl-11">
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[0.67rem] font-[700] bg-[#8B2BFF]/10 text-[#8B2BFF]">
                  Survey
                </span>
              </div>
            </div>

            <div className="bg-[#FDFCFA] rounded-xl p-4 flex flex-col gap-3" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.04)' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#200842]/5 flex items-center justify-center shrink-0 text-[#200842]">
                    <Briefcase className="w-4 h-4" />
                  </div>
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-tight">
                    Whitmore Road
                  </h3>
                </div>
                <ChevronRight className="w-4 h-4 text-[#200842]/30" />
              </div>
              <div className="pl-11">
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[0.67rem] font-[700] bg-[#8B2BFF]/10 text-[#8B2BFF]">
                  Fitting
                </span>
              </div>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
