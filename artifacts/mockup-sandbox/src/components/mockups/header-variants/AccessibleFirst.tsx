import React from 'react';
import { Users, Settings, Search, ChevronDown } from 'lucide-react';

export function AccessibleFirst() {
  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <header className="flex h-[56px] items-center justify-between px-4" style={{ backgroundColor: '#1e1340', color: 'white' }}>
        
        {/* Left Section: Logo & Nav */}
        <div className="flex items-center gap-4">
          <a 
            href="#" 
            className="flex items-center gap-2 rounded-md ring-offset-[#1e1340] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white focus-visible:ring-offset-2 min-h-[44px] min-w-[44px] px-2 transition-colors"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded bg-white/20" aria-hidden="true">
              <span className="text-[10px] font-bold leading-none">HW</span>
            </div>
            <span className="text-[16px] font-semibold">Harry Wardrobes</span>
          </a>

          <div className="h-6 w-px bg-white/20 mx-2" aria-hidden="true" />

          <nav aria-label="Primary Navigation" className="flex items-center gap-2">
            <a 
              href="#" 
              className="flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 ring-offset-[#1e1340] hover:bg-white/20 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white focus-visible:ring-offset-2 min-h-[44px] min-w-[44px] transition-colors" 
              aria-current="page"
            >
              <Users className="h-5 w-5" aria-hidden="true" />
              <span className="text-[13px] font-medium">Customers</span>
            </a>
            <a 
              href="#" 
              className="flex items-center gap-2 rounded-full px-4 py-2 ring-offset-[#1e1340] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white focus-visible:ring-offset-2 min-h-[44px] min-w-[44px] transition-colors text-white/90"
            >
              <Settings className="h-5 w-5" aria-hidden="true" />
              <span className="text-[13px] font-medium">Admin</span>
            </a>
          </nav>
        </div>

        {/* Right Section: Search, Status, Profile */}
        <div className="flex items-center gap-4">
          
          <div className="relative flex items-center">
            <label htmlFor="global-search" className="sr-only">Search customers</label>
            <div className="pointer-events-none absolute left-4 flex items-center" aria-hidden="true">
              <Search className="h-5 w-5 text-white/70" />
            </div>
            <input 
              id="global-search"
              type="search" 
              placeholder="Search..." 
              className="min-h-[44px] w-64 rounded-full border border-white/20 bg-white/10 py-2 pl-11 pr-4 text-[13px] text-white placeholder:text-white/70 ring-offset-[#1e1340] focus:bg-white/20 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white focus-visible:ring-offset-2 transition-colors"
            />
          </div>

          <button 
            type="button" 
            className="flex items-center gap-2 rounded-full px-4 py-2 ring-offset-[#1e1340] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white focus-visible:ring-offset-2 min-h-[44px] min-w-[44px] transition-colors" 
            aria-label="Service Status: All services healthy"
          >
            <div className="h-3 w-3 rounded-full bg-green-400" aria-hidden="true" />
            <span className="text-[13px] font-medium text-white/90">Services</span>
            <ChevronDown className="h-4 w-4 text-white/70" aria-hidden="true" />
          </button>

          <div className="h-6 w-px bg-white/20 mx-1" aria-hidden="true" />

          <button 
            type="button" 
            className="flex items-center gap-3 rounded-full px-2 py-1 ring-offset-[#1e1340] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white focus-visible:ring-offset-2 min-h-[44px] min-w-[44px] transition-colors"
            aria-label="User profile menu for Sandra Dykstra"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 text-sm font-semibold shadow-inner" aria-hidden="true">
              SD
            </div>
            <div className="flex flex-col items-start pr-2">
              <span className="text-[12px] font-medium text-white/70" aria-hidden="true">Sandra Dykstra</span>
            </div>
          </button>

        </div>
      </header>
      
      {/* Rest of page mock content */}
      <main className="p-8">
        <div className="max-w-5xl mx-auto space-y-6">
          <h1 className="text-2xl font-semibold text-gray-900">Customers</h1>
          <div className="h-64 rounded-lg border border-gray-200 bg-white shadow-sm flex items-center justify-center text-gray-400">
            Page content area
          </div>
        </div>
      </main>
    </div>
  );
}
