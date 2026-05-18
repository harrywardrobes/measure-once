import React, { useState } from 'react';
import { ChevronRight, ArrowLeft, CheckCircle2, User, Mail, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

type Step = 'start' | 'returning' | 'new' | 'done';

export function Conversational() {
  const [step, setStep] = useState<Step>('start');
  const [animate, setAnimate] = useState(true);

  const handleStepChange = (newStep: Step) => {
    setAnimate(false);
    setTimeout(() => {
      setStep(newStep);
      setAnimate(true);
    }, 150);
  };

  const getStepProgress = () => {
    switch (step) {
      case 'start': return 1;
      case 'returning':
      case 'new': return 2;
      case 'done': return 3;
      default: return 1;
    }
  };

  const progress = getStepProgress();

  return (
    <div className="min-h-[100dvh] w-full max-w-[440px] mx-auto overflow-hidden flex flex-col font-sans relative" style={{ backgroundColor: '#F6F1E7', color: '#200842' }}>
      
      {/* Header */}
      <header className="px-6 pt-12 pb-6 flex items-center justify-between shrink-0 z-10">
        <div style={{ fontFamily: "'Anton', sans-serif" }} className="text-[#200842] text-sm tracking-wide uppercase">
          MEASURE ONCE
        </div>
        <div className="flex items-center gap-1.5">
          <div className={cn("w-2 h-2 rounded-full transition-all duration-300", progress >= 1 ? "bg-[#8B2BFF]" : "bg-[#200842]/10")} />
          <div className={cn("w-2 h-2 rounded-full transition-all duration-300", progress >= 2 ? "bg-[#8B2BFF]" : "bg-[#200842]/10")} />
          <div className={cn("w-2 h-2 rounded-full transition-all duration-300", progress >= 3 ? "bg-[#8B2BFF]" : "bg-[#200842]/10")} />
        </div>
      </header>

      {/* Content Area */}
      <main className="flex-1 px-6 flex flex-col justify-center pb-24 z-10">
        <div className={cn(
          "transition-all duration-300 ease-in-out transform flex flex-col gap-8",
          animate ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
        )}>
          
          {step === 'start' && (
            <>
              <h1 className="text-4xl font-serif tracking-tight text-[#200842] leading-tight pr-4">
                Have we met before?
              </h1>
              <div className="flex flex-col gap-3 mt-4">
                <button 
                  onClick={() => handleStepChange('returning')}
                  className="w-full flex items-center justify-between bg-[#200842] text-white p-5 rounded-2xl hover:bg-[#200842]/90 transition-colors group"
                >
                  <span className="text-lg font-medium">I have an account</span>
                  <ChevronRight className="w-5 h-5 text-white/50 group-hover:text-white transition-colors" />
                </button>
                <button 
                  onClick={() => handleStepChange('new')}
                  className="w-full flex items-center justify-between bg-transparent border-2 border-[#200842]/10 text-[#200842] p-5 rounded-2xl hover:border-[#200842]/30 hover:bg-[#200842]/5 transition-all group"
                >
                  <span className="text-lg font-medium">I'm new here</span>
                  <ChevronRight className="w-5 h-5 text-[#200842]/30 group-hover:text-[#200842] transition-colors" />
                </button>
              </div>
            </>
          )}

          {step === 'returning' && (
            <>
              <div className="flex flex-col gap-2">
                <button 
                  onClick={() => handleStepChange('start')}
                  className="flex items-center gap-2 text-[#200842]/60 hover:text-[#200842] transition-colors w-fit mb-4 -ml-2 p-2 rounded-lg"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span className="text-sm font-medium">Back</span>
                </button>
                <h1 className="text-4xl font-serif tracking-tight text-[#200842] leading-tight">
                  Welcome back.
                </h1>
                <p className="text-[0.95rem] text-[#200842]/70 leading-relaxed mt-2">
                  Ready to check on your projects? Sign in to continue to your dashboard.
                </p>
              </div>
              
              <div className="flex flex-col gap-4 mt-6">
                <button 
                  onClick={(e) => e.preventDefault()}
                  className="w-full flex items-center justify-center gap-3 bg-[#FDFCFA] text-[#0f172a] border border-[#200842]/10 shadow-sm p-4 rounded-xl hover:bg-white hover:border-[#200842]/20 transition-all font-medium"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2008/svg">
                    <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                  </svg>
                  <span>Sign in with Replit</span>
                </button>
                
                <button className="text-sm text-[#200842]/50 hover:text-[#200842] transition-colors font-medium mt-2">
                  Use a different option
                </button>
              </div>
            </>
          )}

          {step === 'new' && (
            <>
              <div className="flex flex-col gap-2">
                <button 
                  onClick={() => handleStepChange('start')}
                  className="flex items-center gap-2 text-[#200842]/60 hover:text-[#200842] transition-colors w-fit mb-2 -ml-2 p-2 rounded-lg"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span className="text-sm font-medium">Back</span>
                </button>
                <h1 className="text-4xl font-serif tracking-tight text-[#200842] leading-tight">
                  Tell us a little about you.
                </h1>
                <p className="text-[0.95rem] text-[#200842]/70 leading-relaxed mt-2">
                  Measure Once is an invite-only dashboard for our clients. Request access below.
                </p>
              </div>

              <div className="flex flex-col gap-4 mt-2">
                <div className="relative">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-[#200842]/40">
                    <User className="w-5 h-5" />
                  </div>
                  <input 
                    type="text" 
                    placeholder="Your name"
                    aria-label="Your name"
                    className="w-full bg-[#FDFCFA] border border-[#200842]/10 rounded-xl py-4 pl-12 pr-4 text-[#200842] placeholder:text-[#200842]/40 focus:outline-none focus:ring-2 focus:ring-[#8B2BFF]/50 focus:border-[#8B2BFF] transition-all"
                  />
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-[#200842]/40">
                    <Mail className="w-5 h-5" />
                  </div>
                  <input 
                    type="email" 
                    placeholder="Email address"
                    aria-label="Email address"
                    className="w-full bg-[#FDFCFA] border border-[#200842]/10 rounded-xl py-4 pl-12 pr-4 text-[#200842] placeholder:text-[#200842]/40 focus:outline-none focus:ring-2 focus:ring-[#8B2BFF]/50 focus:border-[#8B2BFF] transition-all"
                  />
                </div>
                <div className="relative">
                  <div className="absolute top-4 left-4 pointer-events-none text-[#200842]/40">
                    <MessageSquare className="w-5 h-5" />
                  </div>
                  <textarea 
                    placeholder="What brings you here?"
                    aria-label="What brings you here?"
                    rows={3}
                    className="w-full bg-[#FDFCFA] border border-[#200842]/10 rounded-xl py-4 pl-12 pr-4 text-[#200842] placeholder:text-[#200842]/40 focus:outline-none focus:ring-2 focus:ring-[#8B2BFF]/50 focus:border-[#8B2BFF] transition-all resize-none"
                  />
                </div>
                
                <button 
                  onClick={() => handleStepChange('done')}
                  className="w-full bg-[#200842] text-white p-4 rounded-xl hover:bg-[#200842]/90 transition-colors font-medium mt-2"
                >
                  Send request
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center justify-center text-center py-8">
              <div className="w-16 h-16 rounded-full bg-[#8B2BFF]/10 flex items-center justify-center text-[#8B2BFF] mb-6">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h1 className="text-3xl font-serif tracking-tight text-[#200842] leading-tight mb-3">
                Lovely — we'll be in touch.
              </h1>
              <p className="text-[0.95rem] text-[#200842]/70 leading-relaxed mb-8 max-w-[280px]">
                Request received. We'll review it and get back to you within a working day.
              </p>
              <button 
                onClick={() => handleStepChange('start')}
                className="w-full bg-transparent border-2 border-[#200842]/10 text-[#200842] p-4 rounded-xl hover:border-[#200842]/30 hover:bg-[#200842]/5 transition-all font-medium"
              >
                Done
              </button>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
