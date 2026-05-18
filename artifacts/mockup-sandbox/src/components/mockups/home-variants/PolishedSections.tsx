import React from "react";
import { 
  Calendar, 
  CheckCircle2, 
  ChevronRight, 
  Clock, 
  CreditCard,
  Briefcase
} from "lucide-react";

export function PolishedSections() {
  return (
    <div className="min-h-screen bg-[#F6F1E7] font-sans overflow-x-hidden pb-12 w-full max-w-[390px] mx-auto border-x border-[#EADFCB] shadow-sm relative">
      {/* Header */}
      <header className="px-5 pt-10 pb-5 border-b border-[#EADFCB]/80 mb-6">
        <h1 className="text-[1.6rem] font-[800] text-[#200842] leading-tight tracking-tight">
          Monday
        </h1>
        <p className="text-[0.85rem] font-medium text-gray-500 mt-0.5">
          18 May 2026
        </p>
      </header>

      <div className="px-5 space-y-9">
        {/* Tasks Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-[0.72rem] font-[700] uppercase tracking-wide text-gray-500">
                My Tasks
              </h2>
              <span className="flex items-center gap-1.5 bg-red-100 text-red-700 px-2 py-0.5 rounded-full text-[0.72rem] font-bold">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></span>
                2 Overdue
              </span>
            </div>
            <button className="text-[0.72rem] font-[700] text-[#8B2BFF] hover:text-[#6c22c7] transition-colors flex items-center">
              See all
              <ChevronRight className="w-3 h-3 ml-0.5" />
            </button>
          </div>
          
          <div className="space-y-3">
            <div className="bg-[#FBFAF5] rounded-[12px] p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-start gap-3 transition-transform active:scale-[0.98]">
              <div className="mt-0.5 shrink-0">
                <div className="w-5 h-5 rounded-full border-2 border-red-300 bg-red-50 flex items-center justify-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                </div>
              </div>
              <div>
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-snug mb-1">
                  Measure kitchen units
                </h3>
                <p className="text-[0.75rem] text-gray-500">
                  Mrs Patterson • <span className="text-red-600 font-medium">Overdue</span>
                </p>
              </div>
            </div>

            <div className="bg-[#FBFAF5] rounded-[12px] p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-start gap-3 transition-transform active:scale-[0.98]">
              <div className="mt-0.5 shrink-0">
                <div className="w-5 h-5 rounded-full border-2 border-red-300 bg-red-50 flex items-center justify-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                </div>
              </div>
              <div>
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-snug mb-1">
                  Submit survey report
                </h3>
                <p className="text-[0.75rem] text-gray-500">
                  <span className="text-red-600 font-medium">Overdue</span>
                </p>
              </div>
            </div>

            <div className="bg-[#FBFAF5] rounded-[12px] p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-start gap-3 transition-transform active:scale-[0.98]">
              <div className="mt-0.5 shrink-0">
                <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
              </div>
              <div>
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-snug mb-1">
                  Site visit – Whitmore Road
                </h3>
                <p className="text-[0.75rem] text-gray-500">
                  Due today
                </p>
              </div>
            </div>
            
            <div className="bg-[#FBFAF5] rounded-[12px] p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-start gap-3 transition-transform active:scale-[0.98]">
              <div className="mt-0.5 shrink-0">
                <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
              </div>
              <div>
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-snug mb-1">
                  Call supplier re: hinges
                </h3>
                <p className="text-[0.75rem] text-gray-500">
                  Due today
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Upcoming Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[0.72rem] font-[700] uppercase tracking-wide text-gray-500">
              Upcoming
            </h2>
          </div>
          <div className="space-y-3">
            <div className="bg-[#FBFAF5] rounded-[12px] p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-full bg-[#f0e8fa] text-[#8B2BFF] flex items-center justify-center shrink-0">
                <Calendar className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-snug mb-0.5 truncate">
                  Survey – 42 Elm Street
                </h3>
                <p className="text-[0.75rem] text-gray-500">
                  Mon 18 May • 10:00
                </p>
              </div>
            </div>
            <div className="bg-[#FBFAF5] rounded-[12px] p-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-center gap-3.5">
              <div className="w-10 h-10 rounded-full bg-[#f0e8fa] text-[#8B2BFF] flex items-center justify-center shrink-0">
                <Clock className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[0.88rem] font-[600] text-[#200842] leading-snug mb-0.5 truncate">
                  Team standup
                </h3>
                <p className="text-[0.75rem] text-gray-500">
                  14:30
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Invoices Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[0.72rem] font-[700] uppercase tracking-wide text-gray-500">
              Overdue Invoices
            </h2>
            <button className="text-[0.72rem] font-[700] text-[#8B2BFF] hover:text-[#6c22c7] transition-colors flex items-center">
              View all
              <ChevronRight className="w-3 h-3 ml-0.5" />
            </button>
          </div>
          <div className="space-y-3">
            <div className="bg-[#FBFAF5] rounded-[12px] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                  <CreditCard className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-[0.88rem] font-[600] text-[#200842]">
                    Harrison & Co
                  </h3>
                  <p className="text-[0.75rem] text-red-600 font-medium">
                    Overdue
                  </p>
                </div>
              </div>
              <span className="text-[0.95rem] font-[700] text-[#200842]">
                £1,240
              </span>
            </div>
            
            <div className="bg-[#FBFAF5] rounded-[12px] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-red-50 text-red-600 flex items-center justify-center shrink-0">
                  <CreditCard className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-[0.88rem] font-[600] text-[#200842]">
                    Bradley Interiors
                  </h3>
                  <p className="text-[0.75rem] text-red-600 font-medium">
                    Overdue
                  </p>
                </div>
              </div>
              <span className="text-[0.95rem] font-[700] text-[#200842]">
                £880
              </span>
            </div>
          </div>
        </section>

        {/* Projects Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[0.72rem] font-[700] uppercase tracking-wide text-gray-500">
              Active Projects
            </h2>
          </div>
          <div className="space-y-3">
            <div className="bg-[#FBFAF5] rounded-[12px] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-[#200842] text-white flex items-center justify-center shrink-0">
                  <Briefcase className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] truncate">
                    Davies Bedroom
                  </h3>
                  <p className="text-[0.75rem] text-gray-500 truncate">
                    ID: PRJ-001
                  </p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-md bg-[#f0e8fa] text-[#6c22c7] text-[0.72rem] font-bold whitespace-nowrap">
                Measuring
              </span>
            </div>
            
            <div className="bg-[#FBFAF5] rounded-[12px] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-[#200842] text-white flex items-center justify-center shrink-0">
                  <Briefcase className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] truncate">
                    Thompson Kitchen
                  </h3>
                  <p className="text-[0.75rem] text-gray-500 truncate">
                    ID: PRJ-002
                  </p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-md bg-[#f0e8fa] text-[#6c22c7] text-[0.72rem] font-bold whitespace-nowrap">
                Survey
              </span>
            </div>
            
            <div className="bg-[#FBFAF5] rounded-[12px] p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] border border-[#EADFCB]/50 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-[#200842] text-white flex items-center justify-center shrink-0">
                  <Briefcase className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[0.88rem] font-[600] text-[#200842] truncate">
                    Whitmore Road
                  </h3>
                  <p className="text-[0.75rem] text-gray-500 truncate">
                    ID: PRJ-003
                  </p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-md bg-[#f0e8fa] text-[#6c22c7] text-[0.72rem] font-bold whitespace-nowrap">
                Fitting
              </span>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
