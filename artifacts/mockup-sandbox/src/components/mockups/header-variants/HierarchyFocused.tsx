import React from 'react';
import { 
  ChevronLeft, 
  Search, 
  Users, 
  Shield, 
  Database,
  Calendar,
  FileText,
  CloudCog
} from 'lucide-react';

export function HierarchyFocused() {
  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header 
        className="h-16 w-full flex items-center justify-between px-4"
        style={{ backgroundColor: '#2D1B4E' }}
      >
        {/* LEFT: Brand & Navigation */}
        <div className="flex items-center gap-4 flex-1">
          <button className="text-white/70 hover:text-white transition-colors p-1.5 rounded-md hover:bg-white/10">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 text-white font-semibold tracking-tight text-lg">
            <div className="w-7 h-7 rounded bg-gradient-to-br from-purple-400 to-indigo-500 flex items-center justify-center shadow-inner">
              <span className="text-xs font-bold">M</span>
            </div>
            Measure Once
          </div>
        </div>

        {/* CENTER: System Health */}
        <div className="flex items-center justify-center flex-1">
          <div 
            className="flex items-center gap-3 px-3 py-1.5 rounded-full"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.06)' }}
          >
            {/* Sync Pill */}
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/60 text-xs font-medium">
              <CloudCog className="w-3.5 h-3.5" />
              <span>Synced just now</span>
            </div>

            <div className="w-px h-4 bg-white/10 mx-1"></div>

            {/* Service Dots */}
            <div className="flex items-center gap-2">
              <div className="relative group flex items-center justify-center w-6 h-6 rounded-md bg-white/5 text-white/40">
                <Database className="w-3.5 h-3.5" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 border-2 border-[#2D1B4E]"></span>
              </div>
              <div className="relative group flex items-center justify-center w-6 h-6 rounded-md bg-white/5 text-white/40">
                <Calendar className="w-3.5 h-3.5" />
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 border-2 border-[#2D1B4E]"></span>
              </div>
              <div className="relative flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-md bg-amber-500/10 text-amber-400">
                <div className="relative flex items-center justify-center w-5 h-5">
                  <FileText className="w-3.5 h-3.5" />
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500 border-2 border-[#3D2B5E] shadow-[0_0_0_2px_rgba(245,158,11,0.2)]"></span>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider">Reconnect</span>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT: Primary Actions */}
        <div className="flex items-center justify-end gap-1 flex-1">
          {/* Vertical Divider */}
          <div className="w-px h-8 mr-3" style={{ backgroundColor: 'rgba(255, 255, 255, 0.12)' }}></div>

          <button className="flex items-center gap-2 text-white/70 hover:text-white px-2.5 py-1.5 rounded-md hover:bg-white/10 transition-colors mr-1">
            <Search className="w-4 h-4" />
            <div className="flex items-center gap-1">
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-sans font-medium bg-white/10 text-white/60">
                Ctrl
              </kbd>
              <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-sans font-medium bg-white/10 text-white/60">
                K
              </kbd>
            </div>
          </button>

          <button className="relative text-white bg-white/15 p-2 rounded-md transition-colors shadow-inner border-b border-white/10">
            <Users className="w-4 h-4" />
          </button>

          <button className="text-white/70 hover:text-white p-2 rounded-md hover:bg-white/10 transition-colors">
            <Shield className="w-4 h-4" />
          </button>

          <div className="ml-2 relative">
            <button className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-400 text-white text-xs font-bold flex items-center justify-center shadow-md ring-2 ring-white/10 hover:ring-white/30 transition-all">
              SD
            </button>
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-500 border-2 border-[#2D1B4E]"></span>
          </div>
        </div>
      </header>

      {/* Placeholder content area */}
      <main className="flex-1 p-8 text-gray-400 flex items-center justify-center">
        Page Content Area
      </main>
    </div>
  );
}
