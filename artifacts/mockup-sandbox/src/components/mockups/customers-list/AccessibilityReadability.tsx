import React, { useState } from 'react';
import { Search, Plus, Filter, ArrowDownUp, Keyboard, ArrowRight, User } from 'lucide-react';

const CUSTOMERS = [
  { id: 'MO-2451', name: 'Emma Whitfield', postcode: 'SW1A 1AA', value: '£12,500', stageKey: 'sales', lastContact: '2d ago' },
  { id: 'MO-2452', name: 'Oliver & Sophie Hartley', postcode: 'M14 5TQ', value: '£8,200', stageKey: 'designvisit', lastContact: '5d ago' },
  { id: 'MO-2454', name: 'Priya Sharma', postcode: 'LS6 3HF', value: '£15,000', stageKey: 'quote', lastContact: '1w ago' },
  { id: 'MO-2455', name: 'Mr & Mrs Donnelly', postcode: 'EH1 2NG', value: '£4,500', stageKey: 'won', lastContact: '2w ago' },
  { id: 'MO-2456', name: 'Aisha Begum', postcode: 'B15 2TT', value: '£6,800', stageKey: 'sales', lastContact: '1d ago' },
  { id: 'MO-2457', name: 'Tom Walsh', postcode: 'CV1 5RW', value: '£9,300', stageKey: 'survey', lastContact: '3d ago' },
  { id: 'MO-2458', name: 'Rebecca Holloway', postcode: 'OX2 6HG', value: '£11,200', stageKey: 'quote', lastContact: '4d ago' },
  { id: 'MO-2459', name: 'Daniel O\'Connor', postcode: 'N1 9GU', value: '£5,600', stageKey: 'designvisit', lastContact: '2d ago' },
  { id: 'MO-2460', name: 'Yusuf Ahmed', postcode: 'BS8 1TH', value: '£14,800', stageKey: 'won', lastContact: '1w ago' },
  { id: 'MO-2461', name: 'Charlotte Pemberton', postcode: 'SW1A 1AA', value: '£7,900', stageKey: 'survey', lastContact: '5d ago' },
  { id: 'MO-2462', name: 'Ravi Patel', postcode: 'M14 5TQ', value: '£3,200', stageKey: 'sales', lastContact: '1d ago' },
  { id: 'MO-2463', name: 'Lucas Bianchi', postcode: 'LS6 3HF', value: '£18,500', stageKey: 'quote', lastContact: '2w ago' },
];

const STAGE_CONFIG = {
  sales: { label: 'Sales', code: 'S', bg: '#FFF7E6', text: '#92400E', border: '#D97706', icon: '○' },
  designvisit: { label: 'Design Visit', code: 'DV', bg: '#EFF6FF', text: '#1E40AF', border: '#3B82F6', icon: '△' },
  survey: { label: 'Survey', code: 'SV', bg: '#F0FDF4', text: '#166534', border: '#22C55E', icon: '□' },
  quote: { label: 'Quote Sent', code: 'Q', bg: '#FEF3C7', text: '#B45309', border: '#F59E0B', icon: '◇' },
  won: { label: 'Won', code: 'W', bg: '#ECFDF5', text: '#065F46', border: '#10B981', icon: '☆' },
};

export function AccessibilityReadability() {
  const [selectedId, setSelectedId] = useState<string | null>('MO-2454');
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="flex h-screen w-full bg-[#FBFAF5] text-[#141413] font-sans overflow-hidden">
      {/* Skip Link */}
      <a 
        href="#customer-list" 
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:px-6 focus:py-4 focus:bg-[#200842] focus:text-white focus:font-bold focus:rounded-md focus:outline-none focus:ring-4 focus:ring-offset-2 focus:ring-[#200842]"
      >
        Skip to customer list
      </a>

      {/* Left Panel: Customer List */}
      <div className="w-[480px] flex flex-col border-r-2 border-[#141413] bg-white z-10 shrink-0 shadow-[4px_0_24px_rgba(0,0,0,0.05)]">
        
        {/* Header / Controls */}
        <div className="p-6 border-b-2 border-[#141413] flex flex-col gap-6 bg-white shrink-0">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-black tracking-tight text-[#141413]">Customers</h1>
            <button className="flex items-center gap-2 bg-[#200842] text-white px-5 py-3 rounded-md font-bold hover:bg-[#3d0f7a] focus:outline-none focus:ring-4 focus:ring-offset-2 focus:ring-[#200842] min-h-[48px] min-w-[48px]">
              <Plus className="w-6 h-6" aria-hidden="true" />
              <span>New Customer</span>
            </button>
          </div>

          <div className="flex flex-col gap-5">
            {/* Search */}
            <div className="flex flex-col gap-2">
              <label htmlFor="search-input" className="text-[17px] font-bold text-[#141413]">
                Search customers
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <Search className="h-6 w-6 text-[#6B6860]" aria-hidden="true" />
                </div>
                <input
                  id="search-input"
                  type="search"
                  className="block w-full pl-12 pr-4 py-3.5 text-lg border-2 border-[#141413] rounded-md focus:outline-none focus:ring-4 focus:ring-offset-2 focus:ring-[#200842] bg-white text-[#141413] placeholder:text-[#6B6860]"
                  placeholder="e.g. name, postcode or MO-..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {/* Filters Row */}
            <div className="flex gap-4">
              <div className="flex flex-col gap-2 flex-1">
                <label htmlFor="stage-filter" className="text-[17px] font-bold text-[#141413] flex items-center gap-2">
                  <Filter className="w-5 h-5" aria-hidden="true" /> Stage
                </label>
                <select 
                  id="stage-filter"
                  className="block w-full py-3.5 px-4 text-lg border-2 border-[#141413] rounded-md focus:outline-none focus:ring-4 focus:ring-offset-2 focus:ring-[#200842] bg-white text-[#141413] appearance-none"
                >
                  <option value="all">All stages</option>
                  <option value="sales">Sales</option>
                  <option value="designvisit">Design Visit</option>
                  <option value="survey">Survey</option>
                  <option value="quote">Quote Sent</option>
                  <option value="won">Won</option>
                </select>
              </div>

              <div className="flex flex-col gap-2 flex-1">
                <label htmlFor="sort-filter" className="text-[17px] font-bold text-[#141413] flex items-center gap-2">
                  <ArrowDownUp className="w-5 h-5" aria-hidden="true" /> Sort by
                </label>
                <select 
                  id="sort-filter"
                  className="block w-full py-3.5 px-4 text-lg border-2 border-[#141413] rounded-md focus:outline-none focus:ring-4 focus:ring-offset-2 focus:ring-[#200842] bg-white text-[#141413] appearance-none"
                >
                  <option value="newest">Newest first</option>
                  <option value="name-asc">Name A-Z</option>
                  <option value="name-desc">Name Z-A</option>
                </select>
              </div>
            </div>
          </div>

          <div aria-live="polite" className="text-[17px] font-medium text-[#3C3A34] pt-2 border-t-2 border-[#D9D2C2]">
            Showing <strong>{CUSTOMERS.length}</strong> active customers
          </div>
        </div>

        {/* Scrollable List */}
        <div id="customer-list" className="flex-1 overflow-y-auto focus:outline-none" tabIndex={-1}>
          <ul className="flex flex-col m-0 p-0 list-none">
            {CUSTOMERS.map((customer, index) => {
              const stage = STAGE_CONFIG[customer.stageKey as keyof typeof STAGE_CONFIG];
              const isSelected = selectedId === customer.id;
              
              // Simulate focus ring on the second item for visual mockup
              const forceFocusStyle = index === 1 ? "ring-4 ring-offset-2 ring-[#200842]" : "";

              return (
                <li key={customer.id} className="border-b-2 border-[#E8E3D8] last:border-b-0">
                  <button
                    onClick={() => setSelectedId(customer.id)}
                    className={`w-full text-left p-5 min-h-[96px] flex flex-col gap-3 transition-colors focus:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[#200842] ${forceFocusStyle} ${
                      isSelected 
                        ? 'bg-[#F3EAFF] border-l-8 border-l-[#6A12D9] pl-3' 
                        : 'bg-white hover:bg-[#F5F2EB] border-l-8 border-l-transparent'
                    }`}
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <div className="flex justify-between items-start gap-4">
                      <div className="flex flex-col">
                        <span className={`text-xl font-bold ${isSelected ? 'text-[#200842]' : 'text-[#141413]'} underline-offset-4 ${isSelected ? 'underline' : 'group-hover:underline'}`}>
                          {customer.name}
                        </span>
                        <span className="text-[16px] text-[#3C3A34] font-medium mt-1">
                          <span className="sr-only">Customer ID:</span> {customer.id} <span aria-hidden="true">&bull;</span> <span className="sr-only">Postcode:</span> {customer.postcode}
                        </span>
                      </div>
                      
                      {isSelected && (
                        <div className="shrink-0 text-[#6A12D9]" aria-hidden="true">
                          <ArrowRight className="w-7 h-7" />
                        </div>
                      )}
                    </div>
                    
                    <div className="flex justify-between items-end w-full mt-1">
                      <div 
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border-2 font-bold text-[15px]"
                        style={{ 
                          backgroundColor: stage.bg, 
                          color: stage.text, 
                          borderColor: stage.border 
                        }}
                      >
                        <span aria-hidden="true" className="text-lg leading-none">{stage.icon}</span>
                        <span>{stage.code} <span aria-hidden="true">&middot;</span> {stage.label}</span>
                      </div>
                      
                      <div className="flex flex-col items-end text-[16px]">
                        <span className="font-bold text-[#141413]">{customer.value}</span>
                        <span className="text-[#3C3A34] text-[15px]">Updated {customer.lastContact}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Keyboard hints footer */}
        <div className="p-4 border-t-2 border-[#141413] bg-[#FBFAF5] shrink-0 text-[#141413]">
          <div className="flex items-center gap-4 text-[16px] font-medium">
            <Keyboard className="w-6 h-6 shrink-0" aria-hidden="true" />
            <p>
              Use <kbd className="px-2 py-1 bg-white border-2 border-[#D9D2C2] rounded font-mono font-bold text-[14px]">↑</kbd> <kbd className="px-2 py-1 bg-white border-2 border-[#D9D2C2] rounded font-mono font-bold text-[14px]">↓</kbd> to navigate, and <kbd className="px-2 py-1 bg-white border-2 border-[#D9D2C2] rounded font-mono font-bold text-[14px]">Enter</kbd> to select.
            </p>
          </div>
        </div>
      </div>

      {/* Right Panel: Detail Placeholder */}
      <div className="flex-1 bg-[#F5F2EB] flex items-center justify-center p-12">
        <div className="max-w-2xl w-full flex flex-col items-center justify-center text-center p-16 bg-white border-4 border-[#E8E3D8] rounded-xl shadow-sm">
          <div className="w-24 h-24 bg-[#F3EAFF] rounded-full flex items-center justify-center mb-8 border-4 border-[#200842]">
            <User className="w-12 h-12 text-[#200842]" aria-hidden="true" />
          </div>
          <h2 className="text-4xl font-black tracking-tight text-[#141413] mb-4">
            Select a customer
          </h2>
          <p className="text-xl text-[#3C3A34] leading-relaxed max-w-lg mb-8">
            Choose a customer from the list on the left to view their full details, project workflow, and communication history.
          </p>
          
          <button 
            className="text-lg font-bold text-[#200842] underline underline-offset-4 decoration-2 hover:text-[#6A12D9] focus:outline-none focus:ring-4 focus:ring-offset-4 focus:ring-[#200842] rounded-sm"
            onClick={() => document.getElementById('customer-list')?.focus()}
          >
            Return to customer list
          </button>
        </div>
      </div>
    </div>
  );
}
