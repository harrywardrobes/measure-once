import React, { useState } from 'react';
import { ArrowRight, Send } from 'lucide-react';
import { cn } from '@/lib/utils';

export function DualAction() {
  const [tab, setTab] = useState<'signin' | 'request'>('signin');

  return (
    <div 
      className="min-h-[100dvh] w-full max-w-[440px] mx-auto flex flex-col justify-center px-5 font-sans relative"
      style={{ backgroundColor: '#200842' }}
    >
      {/* Optional subtle background noise/texture could go here, but keeping it clean per prompt */}
      
      <div 
        className="w-full rounded-[2rem] p-7 md:p-8 relative z-10 flex flex-col transition-all duration-500 ease-out"
        style={{ backgroundColor: '#F6F1E7', boxShadow: '0 20px 40px -12px rgba(0,0,0,0.5)' }}
      >
        {/* Wordmark */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-1">
            <h1 
              className="text-2xl tracking-[0.05em] uppercase text-center m-0 leading-none"
              style={{ fontFamily: '"Anton", sans-serif', color: '#200842' }}
            >
              Measure Once
            </h1>
          </div>
          <div className="h-0.5 w-8 bg-[#8B2BFF] rounded-full mt-2" />
        </div>

        {/* Segmented Toggle */}
        <div 
          className="flex p-1.5 rounded-2xl mb-8 relative"
          style={{ backgroundColor: 'rgba(32, 8, 66, 0.06)' }}
        >
          {/* Animated background pill */}
          <div 
            className="absolute top-1.5 bottom-1.5 left-1.5 w-[calc(50%_-_6px)] rounded-xl transition-transform duration-300 ease-out shadow-sm"
            style={{ 
              backgroundColor: '#200842',
              transform: tab === 'signin' ? 'translateX(0)' : 'translateX(100%)',
            }}
          />
          
          <button
            onClick={() => setTab('signin')}
            className={cn(
              "flex-1 py-2.5 text-sm font-semibold rounded-xl z-10 transition-colors duration-300",
              tab === 'signin' ? "text-[#F6F1E7]" : "text-[#200842]/60 hover:text-[#200842]"
            )}
          >
            Sign in
          </button>
          <button
            onClick={() => setTab('request')}
            className={cn(
              "flex-1 py-2.5 text-sm font-semibold rounded-xl z-10 transition-colors duration-300",
              tab === 'request' ? "text-[#F6F1E7]" : "text-[#200842]/60 hover:text-[#200842]"
            )}
          >
            Request access
          </button>
        </div>

        {/* Panels */}
        <div className="relative min-h-[160px]">
          {/* Sign In Panel */}
          <div 
            className={cn(
              "absolute inset-0 flex flex-col transition-all duration-300",
              tab === 'signin' ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 -translate-x-4 pointer-events-none"
            )}
          >
            <p className="text-center text-[0.95rem] font-medium mb-6" style={{ color: '#0f172a' }}>
              Welcome back. Sign in to view your projects, schedule, and sales pipeline.
            </p>
            
            <button 
              className="w-full flex items-center justify-center gap-3 py-3.5 px-4 rounded-xl font-semibold transition-all active:scale-[0.98] mt-auto"
              style={{ backgroundColor: '#200842', color: '#F6F1E7' }}
            >
              Sign in with Replit
              <ArrowRight className="w-4 h-4 opacity-80" />
            </button>
            
            <p className="text-center text-xs mt-4 font-medium" style={{ color: 'rgba(32, 8, 66, 0.4)' }}>
              Secure authentication via Replit OIDC
            </p>
          </div>

          {/* Request Access Panel */}
          <div 
            className={cn(
              "absolute inset-0 flex flex-col transition-all duration-300",
              tab === 'request' ? "opacity-100 translate-x-0 pointer-events-auto" : "opacity-0 translate-x-4 pointer-events-none"
            )}
          >
            <div className="flex flex-col gap-4 mb-6">
              <input 
                type="text" 
                placeholder="Full name"
                aria-label="Full name"
                className="w-full bg-transparent border-b pb-2 text-sm font-medium focus:outline-none transition-colors"
                style={{ borderColor: 'rgba(32, 8, 66, 0.15)', color: '#0f172a' }}
              />
              <input 
                type="email" 
                placeholder="Email address"
                aria-label="Email address"
                className="w-full bg-transparent border-b pb-2 text-sm font-medium focus:outline-none transition-colors"
                style={{ borderColor: 'rgba(32, 8, 66, 0.15)', color: '#0f172a' }}
              />
              <input 
                type="text" 
                placeholder="What you'd use it for"
                aria-label="What you'd use it for"
                className="w-full bg-transparent border-b pb-2 text-sm font-medium focus:outline-none transition-colors"
                style={{ borderColor: 'rgba(32, 8, 66, 0.15)', color: '#0f172a' }}
              />
            </div>
            
            <button 
              className="w-full flex items-center justify-center gap-3 py-3.5 px-4 rounded-xl font-semibold transition-all active:scale-[0.98] mt-auto"
              style={{ backgroundColor: '#200842', color: '#F6F1E7' }}
            >
              Send request
              <Send className="w-4 h-4 opacity-80" />
            </button>
          </div>
        </div>
      </div>

      {/* Footer Microcopy */}
      <div className="mt-8 text-center px-4">
        <p className="text-[0.75rem] font-medium leading-relaxed opacity-60 text-white">
          Invite-only · We review every request within a working day.
        </p>
      </div>
      
      {/* Inject Anton font just for this mockup to be safe */}
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=Anton&display=swap');
      `}} />
    </div>
  );
}
