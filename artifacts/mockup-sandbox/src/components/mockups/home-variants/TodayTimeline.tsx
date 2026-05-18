import React from 'react';
import { Clock, AlertCircle, MapPin, Users, Calendar, ChevronRight } from 'lucide-react';

export function TodayTimeline() {
  return (
    <div className="mx-auto w-full max-w-[390px] h-[844px] overflow-hidden bg-[#F6F1E7] relative font-sans text-slate-900 shadow-xl ring-1 ring-slate-900/5">
      {/* Scrollable content area */}
      <div className="h-full overflow-y-auto pb-24 scrollbar-hide">
        
        {/* Header - Deep Plum */}
        <div className="bg-[#200842] text-[#F6F1E7] px-6 pt-14 pb-8 rounded-b-3xl shadow-md z-10 relative">
          <div className="text-sm font-medium text-white/60 mb-1 uppercase tracking-wider">Today</div>
          <h1 className="text-3xl font-light mb-1">Thursday, 24th</h1>
          <p className="text-[#8B2BFF] font-medium">3 events • 2 flags</p>
        </div>

        {/* Flags Section */}
        <div className="px-5 mt-6 mb-6">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Needs Attention</h2>
          <div className="space-y-2.5">
            <div className="flex items-center gap-3 bg-white/60 backdrop-blur-sm px-3 py-3 rounded-xl border border-red-200/60 shadow-sm relative overflow-hidden">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500"></div>
              <AlertCircle size={18} className="text-red-500 flex-shrink-0 ml-1" />
              <div className="flex-1 text-sm font-semibold text-slate-800">Measure Mrs Patterson</div>
              <div className="text-xs font-bold text-red-600 bg-red-100 px-2 py-1 rounded-md">2d late</div>
            </div>
            <div className="flex items-center gap-3 bg-white/60 backdrop-blur-sm px-3 py-3 rounded-xl border border-red-200/60 shadow-sm relative overflow-hidden">
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-red-500"></div>
              <AlertCircle size={18} className="text-red-500 flex-shrink-0 ml-1" />
              <div className="flex-1 text-sm font-semibold text-slate-800">Harrison & Co invoice</div>
              <div className="text-xs font-bold text-red-600 bg-red-100 px-2 py-1 rounded-md">£1,240</div>
            </div>
          </div>
        </div>

        {/* Timeline */}
        <div className="px-5 mt-8 relative">
          <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Schedule</h2>
          
          <div className="relative pl-14">
            {/* Timeline hour markers */}
            <div className="absolute left-0 top-0 bottom-0 w-12 flex flex-col font-medium text-slate-400 text-xs text-right pr-3 pt-2">
              <div className="h-20 border-b border-transparent">8 AM</div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">9 AM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">10 AM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">11 AM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">12 PM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">1 PM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">2 PM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">3 PM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">4 PM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">5 PM</span></div>
              <div className="h-20 border-b border-transparent relative"><span className="absolute -top-2 right-3">6 PM</span></div>
            </div>

            {/* Horizontal Guide Lines */}
            <div className="absolute left-14 right-0 top-0 bottom-0 flex flex-col pointer-events-none">
              <div className="h-20 border-t border-slate-200/50 mt-[1.25rem]"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
              <div className="h-20 border-t border-slate-200/50"></div>
            </div>

            {/* Vertical Line */}
            <div className="absolute left-[3.25rem] top-2 bottom-0 w-px bg-slate-300/60"></div>

            {/* Current Time Indicator (11:00 AM = 3 * 5rem = 15rem from 8am) */}
            <div className="absolute left-10 right-0 top-[15rem] z-20 flex items-center mt-2.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[#8B2BFF] absolute -left-[5px] ring-4 ring-[#F6F1E7]"></div>
              <div className="h-[2px] bg-[#8B2BFF] flex-1 shadow-[0_0_8px_rgba(139,43,255,0.4)]"></div>
              <div className="bg-[#8B2BFF] text-white text-[10px] font-bold px-2 py-0.5 rounded ml-2 uppercase shadow-sm">Now</div>
            </div>

            {/* Events Overlay Container */}
            <div className="relative w-full pt-[1.25rem]">
              {/* Event at 9:00 (90 mins = 1.5 * 5rem = 7.5rem height, top = 1 * 5rem = 5rem) */}
              <div className="absolute top-[5rem] w-full left-0 pl-3 pr-0 z-10">
                <div className="bg-white rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.04)] border border-slate-100 p-3.5 h-[7rem] overflow-hidden relative group transition-transform active:scale-[0.98]">
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#8B2BFF]"></div>
                  <h3 className="font-bold text-slate-800 text-[15px] leading-tight mb-1.5">Survey – 42 Elm Street</h3>
                  <div className="flex items-center text-slate-500 text-xs mb-2.5 font-medium">
                    <Clock size={13} className="mr-1.5" />
                    <span>9:00 – 10:30</span>
                  </div>
                  <div className="flex items-center text-slate-500 text-xs gap-3 font-medium">
                    <div className="flex items-center">
                      <MapPin size={13} className="mr-1.5 text-slate-400" />
                      <span>Whitmore Road</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Event at 14:30 (14.5 - 8 = 6.5 * 5rem = 32.5rem top, 30 mins = 0.5 * 5rem = 2.5rem height) */}
              <div className="absolute top-[32.5rem] w-full left-0 pl-3 pr-0 z-10">
                <div className="bg-white rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.04)] border border-slate-100 p-2.5 h-[2.5rem] overflow-hidden relative flex items-center transition-transform active:scale-[0.98]">
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#200842]"></div>
                  <div className="flex items-center justify-between w-full">
                    <h3 className="font-bold text-slate-800 text-sm ml-2">Team standup</h3>
                    <div className="text-slate-500 text-xs font-semibold mr-1">14:30</div>
                  </div>
                </div>
              </div>

              {/* Event at 16:00 (16 - 8 = 8 * 5rem = 40rem top, 1hr = 5rem height) */}
              <div className="absolute top-[40rem] w-full left-0 pl-3 pr-0 z-10">
                <div className="bg-white rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.04)] border border-slate-100 p-3.5 h-[4.5rem] overflow-hidden relative transition-transform active:scale-[0.98]">
                  <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-[#8B2BFF]"></div>
                  <h3 className="font-bold text-slate-800 text-[15px] leading-tight mb-1">Site visit – Whitmore</h3>
                  <div className="flex items-center justify-between mt-1">
                    <div className="flex items-center text-slate-500 text-xs font-medium">
                      <Clock size={13} className="mr-1.5" />
                      <span>16:00 – 17:00</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Spacer for timeline height (8am to 6pm = 10 hours = 50rem) */}
              <div className="h-[52rem]"></div>
            </div>
          </div>
        </div>

        {/* Active Projects */}
        <div className="px-5 mt-6 mb-12 relative z-10 bg-[#F6F1E7]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Active Projects</h2>
            <button className="text-xs font-bold text-[#8B2BFF] flex items-center">View all <ChevronRight size={14} className="ml-0.5" /></button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-4 snap-x pr-5 -mr-5 pl-1 scrollbar-hide">
            <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-4 min-w-[150px] flex-shrink-0 snap-start">
              <div className="w-10 h-10 rounded-full bg-[#8B2BFF]/10 text-[#8B2BFF] flex items-center justify-center mb-3">
                <Users size={18} />
              </div>
              <div className="font-bold text-[15px] text-slate-800">Davies Bedroom</div>
              <div className="text-sm font-medium text-slate-500 mt-1">Measuring</div>
            </div>
            <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-4 min-w-[150px] flex-shrink-0 snap-start">
              <div className="w-10 h-10 rounded-full bg-[#200842]/10 text-[#200842] flex items-center justify-center mb-3">
                <Calendar size={18} />
              </div>
              <div className="font-bold text-[15px] text-slate-800">Thompson Kitchen</div>
              <div className="text-sm font-medium text-slate-500 mt-1">Fitting</div>
            </div>
            <div className="bg-white/50 border border-slate-200 border-dashed rounded-2xl p-4 min-w-[110px] flex-shrink-0 snap-start flex flex-col items-center justify-center text-slate-600 hover:bg-white transition-colors cursor-pointer">
              <div className="font-bold text-sm">+2 more</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
