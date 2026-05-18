import React from 'react';
import { AlertCircle, Clock, Calendar, FileText, Briefcase, ChevronRight } from 'lucide-react';

type FeedItem = {
  id: string;
  type: 'invoice' | 'task' | 'event' | 'project';
  title: string;
  subtitle: string;
  urgencyLevel: 'overdue' | 'today' | 'active';
  meta?: string;
  icon: React.ReactNode;
};

const feedItems: FeedItem[] = [
  {
    id: '1',
    type: 'invoice',
    title: 'Harrison & Co',
    subtitle: '£1,240 outstanding',
    urgencyLevel: 'overdue',
    meta: '3 days overdue',
    icon: <FileText size={14} />
  },
  {
    id: '2',
    type: 'task',
    title: 'Measure kitchen units',
    subtitle: 'Mrs Patterson',
    urgencyLevel: 'overdue',
    meta: '2 days ago',
    icon: <AlertCircle size={14} />
  },
  {
    id: '3',
    type: 'task',
    title: 'Submit survey report',
    subtitle: '14 Oak Lane',
    urgencyLevel: 'overdue',
    meta: 'Yesterday',
    icon: <AlertCircle size={14} />
  },
  {
    id: '4',
    type: 'task',
    title: 'Site visit',
    subtitle: 'Whitmore Road',
    urgencyLevel: 'today',
    meta: 'Today',
    icon: <Clock size={14} />
  },
  {
    id: '5',
    type: 'task',
    title: 'Call supplier re: hinges',
    subtitle: '',
    urgencyLevel: 'today',
    meta: 'Today',
    icon: <Clock size={14} />
  },
  {
    id: '6',
    type: 'event',
    title: 'Survey',
    subtitle: '42 Elm Street',
    urgencyLevel: 'today',
    meta: '10:00',
    icon: <Calendar size={14} />
  },
  {
    id: '7',
    type: 'event',
    title: 'Team standup',
    subtitle: '',
    urgencyLevel: 'today',
    meta: '14:30',
    icon: <Calendar size={14} />
  },
  {
    id: '8',
    type: 'project',
    title: 'Davies Bedroom',
    subtitle: 'In Progress',
    urgencyLevel: 'active',
    icon: <Briefcase size={14} />
  },
  {
    id: '9',
    type: 'project',
    title: 'Thompson Kitchen',
    subtitle: 'In Progress',
    urgencyLevel: 'active',
    icon: <Briefcase size={14} />
  }
];

export function UrgencyFeed() {
  return (
    <div className="w-full h-full min-h-[100dvh] overflow-y-auto bg-[#200842] text-[#F6F1E7] font-sans flex justify-center">
      <div className="w-full max-w-[390px] bg-[#200842] min-h-screen flex flex-col relative shadow-2xl" style={{ fontFamily: '"Open Sans", sans-serif' }}>
        {/* Header */}
        <div className="px-5 pt-10 pb-4 sticky top-0 bg-[#200842]/95 backdrop-blur-md z-10 border-b border-[#8B2BFF]/20">
          <div className="text-xs uppercase tracking-widest text-[#F6F1E7]/60 font-semibold mb-1">Today's Priority</div>
          <h1 className="text-3xl font-bold tracking-tight text-[#F6F1E7]">Urgency Feed</h1>
        </div>

        {/* Feed List */}
        <div className="flex-1 px-4 py-5 flex flex-col gap-3">
          {feedItems.map(item => {
            const typeConfig = {
              invoice: { border: 'border-l-red-500', text: 'text-red-400', bg: 'bg-red-500/10', cardBorder: 'border-red-500/20' },
              task: { border: 'border-l-[#8B2BFF]', text: 'text-[#8B2BFF]', bg: 'bg-[#8B2BFF]/10', cardBorder: 'border-[#8B2BFF]/20' },
              event: { border: 'border-l-teal-400', text: 'text-teal-400', bg: 'bg-teal-400/10', cardBorder: 'border-teal-400/20' },
              project: { border: 'border-l-amber-400', text: 'text-amber-400', bg: 'bg-amber-400/10', cardBorder: 'border-amber-400/20' }
            };

            const config = typeConfig[item.type];
            const textMuted = 'text-[#F6F1E7]/60';

            return (
              <div 
                key={item.id} 
                className={`group flex items-stretch bg-[#2A1054] rounded-xl overflow-hidden border ${config.cardBorder} transition-all hover:bg-[#321564]`}
              >
                <div className={`w-1.5 flex-shrink-0 ${config.bg}`} style={{ borderLeftWidth: '3px', borderLeftColor: 'currentColor' }} >
                    <div className={`h-full w-full ${config.border}`}></div>
                </div>
                
                <div className="flex-1 p-3.5 flex flex-col justify-center">
                  <div className="flex justify-between items-start mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`${config.text}`}>
                        {item.icon}
                      </span>
                      <span className={`text-[11px] uppercase tracking-wider font-bold ${config.text}`}>
                        {item.type}
                      </span>
                    </div>
                    {item.meta && (
                      <span className={`text-xs font-semibold ${item.urgencyLevel === 'overdue' ? 'text-red-400' : textMuted}`}>
                        {item.meta}
                      </span>
                    )}
                  </div>
                  
                  <h3 className="font-semibold text-base leading-tight mb-0.5 text-[#F6F1E7]">{item.title}</h3>
                  {item.subtitle && (
                    <p className={`text-sm ${textMuted}`}>{item.subtitle}</p>
                  )}
                </div>
                
                <button className={`px-3 flex items-center justify-center ${config.bg} opacity-50 group-hover:opacity-100 transition-opacity border-l ${config.cardBorder}`}>
                  <ChevronRight size={18} className={config.text} />
                </button>
              </div>
            );
          })}
          
          <div className="mt-6 flex justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-[#8B2BFF]/30"></div>
          </div>
        </div>
      </div>
    </div>
  );
}
