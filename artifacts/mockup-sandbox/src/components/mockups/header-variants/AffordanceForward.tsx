import React from "react";
import { 
  Search, 
  Users, 
  Settings2, 
  ShieldAlert,
  ChevronLeft,
  CircleDashed,
  AlertTriangle
} from "lucide-react";

export function AffordanceForward() {
  return (
    <div className="min-h-screen bg-gray-100">
      <header 
        className="w-full flex items-center justify-between px-4" 
        style={{ backgroundColor: "#2D1B4E", height: "72px" }}
      >
        {/* Left: Logo Area */}
        <div className="flex items-center gap-3">
          <button className="flex items-center justify-center w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 transition-colors text-white/70 hover:text-white">
            <ChevronLeft size={20} />
          </button>
          <div className="flex items-center gap-2 text-white">
            <div className="w-8 h-8 rounded bg-gradient-to-tr from-purple-400 to-indigo-400 flex items-center justify-center font-bold text-sm">
              MO
            </div>
            <span className="font-semibold tracking-tight text-white/90">Measure Once</span>
          </div>
          
          <div className="h-8 w-px bg-white/10 mx-2"></div>
          
          {/* Status Sync Pill (healthy) */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10">
            <div className="w-2 h-2 rounded-full bg-emerald-400"></div>
            <span className="text-[11px] font-medium text-white/70">Connected</span>
          </div>
          
          {/* Service Status: QuickBooks Error */}
          <button className="flex flex-col items-center justify-center px-2 py-1 rounded hover:bg-white/5 transition-all group">
            <div className="flex items-center gap-1.5 text-rose-400">
              <AlertTriangle size={14} />
              <span className="text-[10px] font-bold bg-rose-500/20 px-1.5 py-0.5 rounded text-rose-300">Fix QB</span>
            </div>
          </button>
        </div>

        {/* Center: Search */}
        <div className="flex-1 max-w-md mx-4">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-white/40 group-focus-within:text-white/70 transition-colors">
              <Search size={16} />
            </div>
            <input 
              type="text" 
              placeholder="Search… Ctrl K" 
              className="w-full bg-white/[0.08] hover:bg-white/[0.12] focus:bg-white/[0.14] border border-white/20 rounded-full py-2 pl-9 pr-4 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-purple-400/50 transition-all"
            />
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <div className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-white/20 text-[10px] font-medium text-white/40">
                <span>⌘</span><span>K</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Navigation & Profile */}
        <div className="flex items-center gap-2 h-full">
          {/* Nav Items */}
          <div className="flex items-center h-full gap-1 mr-4">
            <button className="relative flex flex-col items-center justify-center w-16 h-full gap-1 bg-white/[0.06] text-white transition-all transform hover:-translate-y-[1px]">
              <Users size={20} className="text-white" />
              <span className="text-[10px] font-medium text-white/90">Customers</span>
              <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-purple-300 rounded-t-full"></div>
            </button>
            
            <button className="relative flex flex-col items-center justify-center w-16 h-full gap-1 text-white/60 hover:bg-white/[0.04] hover:text-white transition-all transform hover:-translate-y-[1px]">
              <ShieldAlert size={20} />
              <span className="text-[10px] font-medium text-white/70">Admin</span>
            </button>
            
            <button className="relative flex flex-col items-center justify-center w-16 h-full gap-1 text-white/60 hover:bg-white/[0.04] hover:text-white transition-all transform hover:-translate-y-[1px]">
              <Settings2 size={20} />
              <span className="text-[10px] font-medium text-white/70">Settings</span>
            </button>
          </div>

          <div className="h-8 w-px bg-white/10 mr-2"></div>

          {/* Profile */}
          <button className="flex items-center gap-2 p-1.5 pr-2 rounded-full hover:bg-white/10 transition-colors">
            <span className="text-xs font-medium text-white/80 max-w-[80px] truncate pl-1 hidden sm:block">Sandra</span>
            <div className="w-[34px] h-[34px] rounded-full bg-indigo-500 border-2 border-white/10 flex items-center justify-center text-xs font-bold text-white shadow-sm overflow-hidden">
              SD
            </div>
          </button>
        </div>
      </header>

      {/* Main Content Area Placeholder */}
      <main className="p-8">
        <div className="max-w-5xl mx-auto">
          <div className="h-64 rounded-xl border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 font-medium">
            Page Content
          </div>
        </div>
      </main>
    </div>
  );
}
