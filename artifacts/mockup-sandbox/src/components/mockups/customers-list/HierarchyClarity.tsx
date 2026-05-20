import React, { useState } from 'react';
import { Search, Filter, Plus, ChevronDown, Clock, MapPin, PoundSterling, FileText } from 'lucide-react';

const STAGES = [
  { id: 'sales', label: 'Sales', color: 'bg-amber-100 text-amber-900 border-amber-200' },
  { id: 'design_visit', label: 'Design Visit', color: 'bg-blue-100 text-blue-900 border-blue-200' },
  { id: 'survey', label: 'Survey', color: 'bg-emerald-100 text-emerald-900 border-emerald-200' },
  { id: 'quote_sent', label: 'Quote Sent', color: 'bg-purple-100 text-purple-900 border-purple-200' },
  { id: 'won', label: 'Won', color: 'bg-teal-100 text-teal-900 border-teal-200' },
];

const CUSTOMERS = [
  // Sales
  { id: '1', name: 'Emma Whitfield', number: 'MO-2451', stage: 'sales', value: '£4,500', postcode: 'SW1A 1AA', staleness: '2h', nextAction: 'Call to qualify' },
  { id: '2', name: 'Oliver & Sophie Hartley', number: 'MO-2452', stage: 'sales', value: '£8,200', postcode: 'M14 5TQ', staleness: '1d', nextAction: 'Send brochure' },
  { id: '3', name: 'James Chen', stage: 'sales', value: '£3,100', postcode: 'BS8 1TH', staleness: '2d', nextAction: 'Follow up' },
  { id: '4', name: 'Priya Sharma', number: 'MO-2455', stage: 'sales', value: '£12,000', postcode: 'LS6 3HF', staleness: '3d', nextAction: 'Confirm dimensions' },
  // Design Visit
  { id: '5', name: 'Mr & Mrs Donnelly', number: 'MO-2448', stage: 'design_visit', value: '£5,800', postcode: 'EH1 2NG', staleness: '4h', nextAction: 'Prepare samples' },
  { id: '6', name: 'Aisha Begum', stage: 'design_visit', value: '£9,500', postcode: 'B15 2TT', staleness: '1d', nextAction: 'Review brief' },
  { id: '7', name: 'Tom Walsh', number: 'MO-2441', stage: 'design_visit', value: '£4,200', postcode: 'CV1 5RW', staleness: '2d', nextAction: 'Confirm appointment' },
  { id: '8', name: 'Rebecca Holloway', stage: 'design_visit', value: '£6,700', postcode: 'OX2 6HG', staleness: '4d', nextAction: 'Reschedule visit' },
  { id: '9', name: 'Daniel O\'Connor', number: 'MO-2439', stage: 'design_visit', value: '£11,200', postcode: 'N1 9GU', staleness: '5d', nextAction: 'Follow up' },
  // Survey
  { id: '10', name: 'Yusuf Ahmed', stage: 'survey', value: '£7,400', postcode: 'SW1A 1AA', staleness: '1h', nextAction: 'Upload measurements' },
  { id: '11', name: 'Charlotte Pemberton', number: 'MO-2430', stage: 'survey', value: '£14,500', postcode: 'M14 5TQ', staleness: '1d', nextAction: 'Review access' },
  { id: '12', name: 'Ravi Patel', stage: 'survey', value: '£3,800', postcode: 'BS8 1TH', staleness: '2d', nextAction: 'Assign surveyor' },
  // Quote Sent
  { id: '13', name: 'Lucas Bianchi', number: 'MO-2425', stage: 'quote_sent', value: '£8,900', postcode: 'LS6 3HF', staleness: '2d', nextAction: 'Awaiting response' },
  { id: '14', name: 'Hannah Greene', stage: 'quote_sent', value: '£5,100', postcode: 'EH1 2NG', staleness: '3d', nextAction: 'Chase quote' },
  { id: '15', name: 'Marco Romano', number: 'MO-2418', stage: 'quote_sent', value: '£18,500', postcode: 'B15 2TT', staleness: '1w', nextAction: 'Final chaser' },
  { id: '16', name: 'Freya Lindqvist', stage: 'quote_sent', value: '£6,200', postcode: 'CV1 5RW', staleness: '2w', nextAction: 'Mark as lost?' },
  // Won
  { id: '17', name: 'Bilal Hussain', number: 'MO-2410', stage: 'won', value: '£9,800', postcode: 'OX2 6HG', staleness: '1d', nextAction: 'Deposit received' },
  { id: '18', name: 'Kate Mitchell', stage: 'won', value: '£4,500', postcode: 'N1 9GU', staleness: '2d', nextAction: 'Schedule manufacture' },
  { id: '19', name: 'Nina Volkov', number: 'MO-2405', stage: 'won', value: '£12,400', postcode: 'SW1A 1AA', staleness: '3d', nextAction: 'Welcome pack sent' },
];

export function HierarchyClarity() {
  const [selectedId, setSelectedId] = useState<string>('5');
  const [activeTab, setActiveTab] = useState<'active' | 'all'>('active');

  const groupedCustomers = STAGES.map(stage => ({
    ...stage,
    customers: CUSTOMERS.filter(c => c.stage === stage.id)
  })).filter(g => g.customers.length > 0);

  return (
    <div className="flex h-screen w-full bg-[#F6F1E7] font-sans antialiased" style={{ fontFamily: '"Plus Jakarta Sans", system-ui, sans-serif' }}>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      
      {/* Left Panel - Customers List */}
      <div className="w-[420px] flex-shrink-0 flex flex-col bg-white border-r border-[#D9D2C2] shadow-[4px_0_24px_rgba(32,8,66,0.03)] z-10 relative">
        
        {/* Header / Filter Bar */}
        <div className="p-5 border-b border-[#D9D2C2] bg-[#FBFAF5] sticky top-0 z-20">
          <div className="flex items-center justify-between mb-5">
            <h1 className="text-xl font-bold text-[#141413] tracking-tight">Customers</h1>
            <button className="flex items-center gap-1.5 bg-[#200842] hover:bg-[#3d0f7a] text-white px-3 py-1.5 rounded-md text-sm font-semibold transition-colors shadow-sm">
              <Plus size={16} strokeWidth={2.5} />
              New
            </button>
          </div>

          <div className="space-y-3">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#97927F]" size={16} />
              <input 
                type="text" 
                placeholder="Search customers, postcodes..." 
                className="w-full pl-9 pr-3 py-2 bg-white border border-[#D9D2C2] rounded-md text-sm text-[#141413] placeholder:text-[#97927F] focus:outline-none focus:border-[#8B2BFF] focus:ring-1 focus:ring-[#8B2BFF] transition-all"
              />
            </div>

            {/* Controls */}
            <div className="flex items-center gap-2">
              <div className="flex bg-[#F5F2EB] p-0.5 rounded-md border border-[#D9D2C2] flex-1">
                <button 
                  onClick={() => setActiveTab('active')}
                  className={`flex-1 py-1 text-xs font-semibold rounded-sm transition-colors ${activeTab === 'active' ? 'bg-white text-[#141413] shadow-sm border border-[#D9D2C2]' : 'text-[#6B6860] hover:text-[#141413]'}`}
                >
                  Active
                </button>
                <button 
                  onClick={() => setActiveTab('all')}
                  className={`flex-1 py-1 text-xs font-semibold rounded-sm transition-colors ${activeTab === 'all' ? 'bg-white text-[#141413] shadow-sm border border-[#D9D2C2]' : 'text-[#6B6860] hover:text-[#141413]'}`}
                >
                  All
                </button>
              </div>

              <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-[#D9D2C2] rounded-md text-xs font-semibold text-[#3C3A34] hover:bg-[#F5F2EB] transition-colors">
                <Filter size={14} />
                Filters
              </button>
            </div>
            
            <div className="text-[11px] font-medium text-[#97927F] uppercase tracking-wider pt-1">
              19 active deals
            </div>
          </div>
        </div>

        {/* Scrollable List */}
        <div className="flex-1 overflow-y-auto pb-8">
          {groupedCustomers.map(group => (
            <div key={group.id} className="mb-4">
              {/* Sticky Stage Header */}
              <div className="sticky top-0 z-10 bg-[#FBFAF5]/95 backdrop-blur-sm border-b border-[#E8E3D8] px-5 py-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${group.color.split(' ')[0]}`} />
                  <h2 className="text-xs font-bold text-[#3C3A34] uppercase tracking-wider">
                    {group.label}
                  </h2>
                </div>
                <span className="text-xs font-semibold text-[#97927F] bg-[#F5F2EB] px-2 py-0.5 rounded-full">
                  {group.customers.length}
                </span>
              </div>

              {/* Cards */}
              <div className="divide-y divide-[#E8E3D8]">
                {group.customers.map(customer => {
                  const isSelected = selectedId === customer.id;
                  
                  return (
                    <div 
                      key={customer.id}
                      onClick={() => setSelectedId(customer.id)}
                      className={`group cursor-pointer p-4 transition-all duration-200 border-l-4 ${
                        isSelected 
                          ? 'bg-[#F3EAFF] border-l-[#8B2BFF]' 
                          : 'bg-white border-l-transparent hover:bg-[#FBFAF5] hover:border-l-[#D9D2C2]'
                      }`}
                    >
                      <div className="flex justify-between items-start mb-1.5">
                        <div className="flex flex-col">
                          <h3 className={`text-[15px] font-bold tracking-tight leading-tight ${isSelected ? 'text-[#200842]' : 'text-[#141413]'}`}>
                            {customer.name}
                          </h3>
                          {customer.number && (
                            <span className="text-[11px] font-medium text-[#97927F] mt-0.5">
                              {customer.number}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-col items-end">
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-sm border ${
                            stalenessColor(customer.staleness)
                          }`}>
                            {customer.staleness}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-3 mt-2.5">
                        <div className="flex items-center gap-1 text-[12px] font-medium text-[#6B6860]">
                          <FileText size={12} className="text-[#97927F]" />
                          <span className="truncate max-w-[140px]">{customer.nextAction}</span>
                        </div>
                      </div>
                      
                      {/* Secondary Meta (de-emphasized) */}
                      <div className="flex items-center gap-3 mt-2 text-[11px] font-medium text-[#97927F] opacity-70 group-hover:opacity-100 transition-opacity">
                        <div className="flex items-center gap-1">
                          <MapPin size={10} />
                          {customer.postcode}
                        </div>
                        <div className="flex items-center gap-1">
                          <PoundSterling size={10} />
                          {customer.value}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Panel - Empty State / Detail View Placeholder */}
      <div className="flex-1 bg-[#F6F1E7] flex flex-col items-center justify-center relative overflow-hidden">
        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(#200842 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>
        
        <div className="bg-white/60 backdrop-blur-md border border-[#D9D2C2] p-8 rounded-2xl shadow-sm text-center max-w-sm relative z-10">
          <div className="w-16 h-16 bg-[#F3EAFF] rounded-full flex items-center justify-center mx-auto mb-4 text-[#8B2BFF]">
            <FileText size={24} strokeWidth={2} />
          </div>
          <h2 className="text-xl font-bold text-[#200842] mb-2 font-serif">Customer Details</h2>
          <p className="text-sm text-[#6B6860] leading-relaxed">
            Select a customer from the hierarchy list on the left to view their complete project history, stages, and next actions.
          </p>
        </div>
      </div>
    </div>
  );
}

// Helper for staleness badge coloring
function stalenessColor(staleness: string) {
  if (staleness.includes('h')) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (staleness === '1d' || staleness === '2d') return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-red-50 text-red-700 border-red-200';
}
