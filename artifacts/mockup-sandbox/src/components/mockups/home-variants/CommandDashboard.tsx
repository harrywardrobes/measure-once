import React from "react";
import { 
  CheckCircle2, 
  Calendar, 
  FileText, 
  Folder, 
  AlertCircle,
  ArrowRight,
  Clock,
  MoreHorizontal
} from "lucide-react";
import { cn } from "@/lib/utils";

export function CommandDashboard() {
  const currentDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });

  return (
    <div className="flex flex-col h-[100dvh] w-full max-w-[390px] mx-auto overflow-hidden bg-[#F6F1E7] font-sans">
      {/* Header Section */}
      <div className="bg-[#200842] text-white pt-12 pb-6 px-5 rounded-b-[32px] shadow-sm z-10">
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-white/60 text-sm font-medium mb-1">Daily Brief</p>
            <h1 className="text-2xl font-semibold tracking-tight">{currentDate}</h1>
          </div>
          <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center border border-white/20">
            <span className="text-sm font-medium">HW</span>
          </div>
        </div>

        {/* 2x2 Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Tasks Tile */}
          <button className="bg-white/10 hover:bg-white/15 transition-colors border border-white/10 rounded-2xl p-4 flex flex-col items-start text-left">
            <div className="flex items-center gap-2 mb-3">
              <div className="bg-[#8B2BFF] p-2 rounded-lg">
                <CheckCircle2 className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-medium text-white/80">Tasks</span>
            </div>
            <div className="text-2xl font-bold mb-1">3</div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400"></div>
              2 overdue
            </div>
          </button>

          {/* Events Tile */}
          <button className="bg-white/10 hover:bg-white/15 transition-colors border border-white/10 rounded-2xl p-4 flex flex-col items-start text-left">
            <div className="flex items-center gap-2 mb-3">
              <div className="bg-[#8B2BFF] p-2 rounded-lg">
                <Calendar className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-medium text-white/80">Events</span>
            </div>
            <div className="text-2xl font-bold mb-1">2</div>
            <div className="text-xs text-white/60 truncate w-full">
              Next: Survey 10:00
            </div>
          </button>

          {/* Invoices Tile */}
          <button className="bg-white/10 hover:bg-white/15 transition-colors border border-white/10 rounded-2xl p-4 flex flex-col items-start text-left">
            <div className="flex items-center gap-2 mb-3">
              <div className="bg-[#8B2BFF] p-2 rounded-lg">
                <FileText className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-medium text-white/80">Invoices</span>
            </div>
            <div className="text-xl font-bold mb-1">£2,480</div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full">
              <div className="w-1.5 h-1.5 rounded-full bg-red-400"></div>
              2 overdue
            </div>
          </button>

          {/* Projects Tile */}
          <button className="bg-white/10 hover:bg-white/15 transition-colors border border-white/10 rounded-2xl p-4 flex flex-col items-start text-left">
            <div className="flex items-center gap-2 mb-3">
              <div className="bg-[#8B2BFF] p-2 rounded-lg">
                <Folder className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-medium text-white/80">Projects</span>
            </div>
            <div className="text-2xl font-bold mb-1">4</div>
            <div className="text-xs text-[#8B2BFF] font-medium bg-[#8B2BFF]/20 px-2 py-0.5 rounded-full">
              Active
            </div>
          </button>
        </div>
      </div>

      {/* Body Section */}
      <div className="flex-1 overflow-y-auto px-5 pt-6 pb-24">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[17px] font-semibold text-[#200842] flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-500" />
            Needs Attention
          </h2>
          <span className="text-xs font-semibold bg-red-100 text-red-600 px-2 py-0.5 rounded-full">
            3 items
          </span>
        </div>

        <div className="space-y-3">
          {/* Overdue Task 1 */}
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-black/5 flex gap-4 items-start active:scale-[0.98] transition-transform">
            <div className="mt-0.5 w-5 h-5 rounded-full border-2 border-red-200 flex-shrink-0"></div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-[#200842] mb-1 leading-tight">Measure kitchen units</p>
              <p className="text-xs text-[#200842]/60 mb-2">Mrs Patterson</p>
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-500">
                <Clock className="w-3.5 h-3.5" />
                <span>Overdue by 2 days</span>
              </div>
            </div>
          </div>

          {/* Overdue Invoice */}
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-black/5 flex gap-4 items-start active:scale-[0.98] transition-transform">
            <div className="mt-0.5 bg-red-100 p-1.5 rounded-md flex-shrink-0 text-red-500">
              <FileText className="w-4 h-4" />
            </div>
            <div className="flex-1">
              <div className="flex justify-between items-start mb-1">
                <p className="text-sm font-semibold text-[#200842] leading-tight">Harrison & Co</p>
                <span className="text-sm font-bold text-red-600">£1,240</span>
              </div>
              <p className="text-xs text-[#200842]/60 mb-2">Invoice #INV-082</p>
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-500">
                <Clock className="w-3.5 h-3.5" />
                <span>Overdue by 5 days</span>
              </div>
            </div>
          </div>

          {/* Overdue Task 2 */}
          <div className="bg-white p-4 rounded-2xl shadow-sm border border-black/5 flex gap-4 items-start active:scale-[0.98] transition-transform">
            <div className="mt-0.5 w-5 h-5 rounded-full border-2 border-red-200 flex-shrink-0"></div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-[#200842] mb-1 leading-tight">Submit survey report</p>
              <p className="text-xs text-[#200842]/60 mb-2">14 Oak Lane</p>
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-500">
                <Clock className="w-3.5 h-3.5" />
                <span>Overdue by 1 day</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mock Bottom Nav (Static) */}
      <div className="absolute bottom-0 left-0 right-0 h-20 bg-white border-t border-black/5 flex items-center justify-around px-6 pb-safe">
        <button className="flex flex-col items-center gap-1 text-[#8B2BFF]">
          <div className="p-1.5 bg-[#8B2BFF]/10 rounded-xl">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <span className="text-[10px] font-semibold">Home</span>
        </button>
        <button className="flex flex-col items-center gap-1 text-[#200842]/40 hover:text-[#200842] transition-colors">
          <div className="p-1.5">
            <Calendar className="w-5 h-5" />
          </div>
          <span className="text-[10px] font-medium">Schedule</span>
        </button>
        <button className="flex flex-col items-center gap-1 text-[#200842]/40 hover:text-[#200842] transition-colors">
          <div className="p-1.5">
            <Folder className="w-5 h-5" />
          </div>
          <span className="text-[10px] font-medium">Projects</span>
        </button>
        <button className="flex flex-col items-center gap-1 text-[#200842]/40 hover:text-[#200842] transition-colors">
          <div className="p-1.5">
            <MoreHorizontal className="w-5 h-5" />
          </div>
          <span className="text-[10px] font-medium">More</span>
        </button>
      </div>
    </div>
  );
}
