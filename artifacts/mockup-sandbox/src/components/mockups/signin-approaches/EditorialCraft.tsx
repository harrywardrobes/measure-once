import React from 'react';

export function EditorialCraft() {
  return (
    <div 
      className="min-h-[100dvh] w-full max-w-[440px] mx-auto flex flex-col relative" 
      style={{ backgroundColor: '#F6F1E7', color: '#200842' }}
    >
      {/* Top Third: Brand Masthead */}
      <div className="pt-20 px-8 flex flex-col shrink-0">
        <h1 
          className="uppercase tracking-tight m-0 p-0"
          style={{ 
            fontFamily: "'Anton', sans-serif", 
            fontSize: '5.5rem', 
            lineHeight: '0.85',
            color: '#200842'
          }}
        >
          Measure<br />Once
        </h1>
        
        <div className="w-full h-[1px] bg-[#200842] mt-6 mb-4 opacity-30"></div>
        
        <p 
          className="text-[0.95rem] opacity-80"
          style={{ 
            fontFamily: "Georgia, serif", 
            fontStyle: 'italic',
            lineHeight: '1.6'
          }}
        >
          Measure twice. Cut once. Sign in to begin.
        </p>
      </div>

      {/* Middle: Generous Quiet Area with Motif */}
      <div className="flex-1 flex flex-col justify-center items-center py-12 shrink-0">
        {/* Decorative Measurement Scale Motif */}
        <div className="flex flex-col items-center opacity-20" aria-hidden="true">
          <div className="w-[1px] h-32 bg-[#200842] relative flex flex-col justify-between items-center py-1">
            <div className="w-4 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-3 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-4 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-3 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-2 h-[1px] bg-[#200842]"></div>
            <div className="w-4 h-[1px] bg-[#200842]"></div>
          </div>
        </div>
      </div>

      {/* Bottom Third: Actions */}
      <div className="pb-16 px-8 flex flex-col gap-6 shrink-0 mt-auto">
        <button 
          className="w-full h-14 flex items-center justify-center gap-3 bg-transparent border-2 border-[#200842] text-[#200842] font-semibold text-[0.95rem] transition-colors hover:bg-[#200842] hover:text-[#F6F1E7]"
          style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="opacity-80">
            <path d="M19 3H5C3.89543 3 3 3.89543 3 5V19C3 20.1046 3.89543 21 5 21H19C20.1046 21 21 20.1046 21 19V5C21 3.89543 20.1046 3 19 3Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 10L12 13L15 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Sign in with Replit
        </button>
        
        <div className="text-center">
          <a 
            href="#"
            onClick={(e) => e.preventDefault()}
            className="text-[0.85rem] text-[#200842] opacity-60 hover:opacity-100 transition-opacity underline underline-offset-4 decoration-[#200842]/30"
            style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}
          >
            Request access
          </a>
        </div>
      </div>
    </div>
  );
}
