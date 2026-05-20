import React, { useState } from 'react';
import {
  Phone,
  Mail,
  ArrowRight,
  ExternalLink,
  ChevronDown,
  Plus,
  Search,
  Filter,
  CheckSquare,
  Square,
  ArrowUpRight,
  MoreVertical,
  Check,
  Archive
} from 'lucide-react';

const CUSTOMERS = [
  { id: '1', number: 'MO-2451', name: 'Emma Whitfield', postcode: 'SW1A 1AA', value: '£12,500', stage: 'Design Visit', stageColor: 'bg-blue-100 text-blue-700', lastContact: '2d', selected: true },
  { id: '2', number: 'MO-2452', name: 'Oliver & Sophie Hartley', postcode: 'M14 5TQ', value: '£18,500', stage: 'Quote Sent', stageColor: 'bg-amber-100 text-amber-700', lastContact: '5d', selected: true },
  { id: '3', number: 'MO-2453', name: 'James Chen', postcode: 'BS8 1TH', value: '£6,200', stage: 'Sales', stageColor: 'bg-yellow-100 text-yellow-700', lastContact: '1d', selected: false },
  { id: '4', number: 'MO-2454', name: 'Priya Sharma', postcode: 'LS6 3HF', value: '£4,800', stage: 'Survey', stageColor: 'bg-green-100 text-green-700', lastContact: '3d', selected: false },
  { id: '5', number: 'MO-2455', name: 'Mr & Mrs Donnelly', postcode: 'EH1 2NG', value: '£14,000', stage: 'Awaiting Deposit', stageColor: 'bg-purple-100 text-purple-700', lastContact: '4d', selected: false },
  { id: '6', number: 'MO-2456', name: 'Aisha Begum', postcode: 'B15 2TT', value: '£9,500', stage: 'Manufacture', stageColor: 'bg-indigo-100 text-indigo-700', lastContact: '1w', selected: false },
  { id: '7', number: 'MO-2457', name: 'Tom Walsh', postcode: 'CV1 5RW', value: '£3,200', stage: 'Install', stageColor: 'bg-teal-100 text-teal-700', lastContact: '2w', selected: false },
  { id: '8', number: 'MO-2458', name: 'Rebecca Holloway', postcode: 'OX2 6HG', value: '£7,900', stage: 'Won', stageColor: 'bg-emerald-100 text-emerald-700', lastContact: '3w', selected: false },
  { id: '9', number: 'MO-2459', name: "Daniel O'Connor", postcode: 'N1 9GU', value: '£11,200', stage: 'Design Visit', stageColor: 'bg-blue-100 text-blue-700', lastContact: '1d', selected: false },
  { id: '10', number: 'MO-2460', name: 'Yusuf Ahmed', postcode: 'SW1A 1AA', value: '£5,600', stage: 'Sales', stageColor: 'bg-yellow-100 text-yellow-700', lastContact: '2d', selected: false },
  { id: '11', number: 'MO-2461', name: 'Charlotte Pemberton', postcode: 'M14 5TQ', value: '£15,000', stage: 'Quote Sent', stageColor: 'bg-amber-100 text-amber-700', lastContact: '4d', selected: false },
  { id: '12', number: 'MO-2462', name: 'Ravi Patel', postcode: 'BS8 1TH', value: '£8,400', stage: 'Survey', stageColor: 'bg-green-100 text-green-700', lastContact: '5d', selected: false },
  { id: '13', number: 'MO-2463', name: 'Lucas Bianchi', postcode: 'LS6 3HF', value: '£10,500', stage: 'Manufacture', stageColor: 'bg-indigo-100 text-indigo-700', lastContact: '1w', selected: false },
  { id: '14', number: 'MO-2464', name: 'Hannah Greene', postcode: 'EH1 2NG', value: '£4,100', stage: 'Sales', stageColor: 'bg-yellow-100 text-yellow-700', lastContact: '2d', selected: false },
  { id: '15', number: 'MO-2465', name: 'Marco Romano', postcode: 'B15 2TT', value: '£13,800', stage: 'Install', stageColor: 'bg-teal-100 text-teal-700', lastContact: '2w', selected: false },
  { id: '16', number: 'MO-2466', name: 'Freya Lindqvist', postcode: 'CV1 5RW', value: '£6,900', stage: 'Quote Sent', stageColor: 'bg-amber-100 text-amber-700', lastContact: '1d', selected: false },
  { id: '17', number: 'MO-2467', name: 'Bilal Hussain', postcode: 'OX2 6HG', value: '£2,800', stage: 'Lost', stageColor: 'bg-red-100 text-red-700', lastContact: '1m', selected: false },
  { id: '18', number: 'MO-2468', name: 'Kate Mitchell', postcode: 'N1 9GU', value: '£16,200', stage: 'Design Visit', stageColor: 'bg-blue-100 text-blue-700', lastContact: '3d', selected: false },
];

export function AffordanceVisibility() {
  const [customers, setCustomers] = useState(CUSTOMERS);
  const selectedCount = customers.filter(c => c.selected).length;

  const toggleSelectAll = () => {
    const allSelected = selectedCount === customers.length;
    setCustomers(customers.map(c => ({ ...c, selected: !allSelected })));
  };

  const toggleSelect = (id: string) => {
    setCustomers(customers.map(c => c.id === id ? { ...c, selected: !c.selected } : c));
  };

  return (
    <div className="flex h-screen w-full bg-[#F5EFE0] font-sans text-[#141413] overflow-hidden">
      {/* Expanded, Affordance-Heavy List Panel */}
      <div className="w-[540px] flex-shrink-0 flex flex-col bg-white border-r border-[#D9D2C2] shadow-xl z-10">
        
        {/* Top Explicit Control Bar */}
        <div className="p-4 border-b border-[#D9D2C2] bg-white flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold tracking-tight text-[#200842]">Customers</h1>
            <button className="flex items-center gap-1.5 px-4 py-2 bg-[#200842] hover:bg-[#3d0f7a] text-white rounded-md font-semibold text-sm shadow-sm transition-colors">
              <Plus className="w-4 h-4" />
              New Customer
            </button>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#97927F]" />
            <input 
              type="text" 
              placeholder="Search by name, postcode, or number..." 
              className="w-full pl-9 pr-4 py-2 border border-[#D9D2C2] rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#8B2BFF] focus:border-transparent placeholder:text-[#97927F]"
            />
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#6B6860] uppercase tracking-wider">View</span>
              <div className="flex bg-[#EDE5D4] p-1 rounded-md">
                <button className="px-3 py-1 bg-white text-[#141413] font-semibold text-xs rounded shadow-sm">Active</button>
                <button className="px-3 py-1 text-[#6B6860] hover:text-[#141413] font-medium text-xs rounded transition-colors">All</button>
                <button className="px-3 py-1 text-[#6B6860] hover:text-[#141413] font-medium text-xs rounded transition-colors">Archived</button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#6B6860] uppercase tracking-wider">Sort by</span>
              <div className="flex bg-[#EDE5D4] p-1 rounded-md">
                <button className="px-3 py-1 bg-white text-[#141413] font-semibold text-xs rounded shadow-sm">Newest</button>
                <button className="px-3 py-1 text-[#6B6860] hover:text-[#141413] font-medium text-xs rounded transition-colors">Name</button>
                <button className="px-3 py-1 text-[#6B6860] hover:text-[#141413] font-medium text-xs rounded transition-colors">Stage</button>
              </div>
            </div>

            <div className="flex gap-2">
              <button className="flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-[#D9D2C2] rounded-md text-sm font-medium text-[#3C3A34] hover:bg-[#F5EFE0] transition-colors bg-white">
                <Filter className="w-4 h-4 text-[#97927F]" />
                Filter by Stage
                <ChevronDown className="w-3 h-3 text-[#97927F] ml-auto" />
              </button>
              <button className="flex-1 flex items-center justify-center gap-2 px-3 py-2 border border-[#D9D2C2] rounded-md text-sm font-medium text-[#3C3A34] hover:bg-[#F5EFE0] transition-colors bg-white">
                Filter by Status
                <ChevronDown className="w-3 h-3 text-[#97927F] ml-auto" />
              </button>
            </div>
          </div>
          
          <div className="flex items-center justify-between mt-2 pt-3 border-t border-[#D9D2C2]">
            <label className="flex items-center gap-2 cursor-pointer group">
              <button 
                onClick={toggleSelectAll}
                className="text-[#6B6860] group-hover:text-[#200842] transition-colors"
              >
                {selectedCount === customers.length ? (
                  <CheckSquare className="w-5 h-5 text-[#8B2BFF]" />
                ) : selectedCount > 0 ? (
                  <div className="w-5 h-5 bg-[#8B2BFF] rounded-sm flex items-center justify-center">
                    <div className="w-3 h-0.5 bg-white rounded-full" />
                  </div>
                ) : (
                  <Square className="w-5 h-5" />
                )}
              </button>
              <span className="text-sm font-medium text-[#3C3A34]">Select All</span>
            </label>
            <span className="text-xs font-medium text-[#6B6860]">{customers.length} customers</span>
          </div>
        </div>

        {/* Sticky Bulk Action Bar */}
        {selectedCount > 0 && (
          <div className="sticky top-0 z-20 bg-[#8B2BFF] text-white px-4 py-3 shadow-md flex items-center justify-between border-b border-[#6A12D9]">
            <span className="text-sm font-semibold">{selectedCount} selected</span>
            <div className="flex gap-2">
              <button className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors border border-white/20">
                <ArrowRight className="w-3.5 h-3.5" />
                Move Stage
              </button>
              <button className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors border border-white/20">
                <Mail className="w-3.5 h-3.5" />
                Email
              </button>
              <button className="px-2 py-1.5 bg-white/10 hover:bg-white/20 rounded text-xs transition-colors border border-white/20" title="More actions">
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Scrollable Customer List */}
        <div className="flex-1 overflow-y-auto bg-[#F5EFE0] p-3 space-y-3">
          {customers.map(customer => (
            <div 
              key={customer.id} 
              className={`bg-white rounded-lg border shadow-sm transition-all overflow-hidden ${
                customer.selected ? 'border-[#8B2BFF] ring-1 ring-[#8B2BFF]' : 'border-[#D9D2C2] hover:border-[#B8AE99]'
              }`}
            >
              <div className="p-3.5 flex gap-3">
                <button 
                  onClick={() => toggleSelect(customer.id)}
                  className="mt-1 flex-shrink-0 text-[#97927F] hover:text-[#8B2BFF] transition-colors"
                >
                  {customer.selected ? (
                    <CheckSquare className="w-5 h-5 text-[#8B2BFF]" />
                  ) : (
                    <Square className="w-5 h-5" />
                  )}
                </button>
                
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-sm text-[#141413] truncate">{customer.name}</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#EDE5D4] text-[#6B6860] flex-shrink-0">
                        {customer.number}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-[#6B6860] whitespace-nowrap ml-2">
                      {customer.lastContact} ago
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${customer.stageColor}`}>
                      {customer.stage}
                    </span>
                    <span className="text-xs text-[#6B6860] flex items-center gap-1 border-l border-[#D9D2C2] pl-2">
                      <span className="font-semibold text-[#3C3A34]">{customer.value}</span>
                      <span className="text-[#97927F] mx-0.5">•</span>
                      {customer.postcode}
                    </span>
                  </div>

                  {/* Explicit Action Buttons Row */}
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-dashed border-[#E8E3D8]">
                    <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#F5F2EB] hover:bg-[#EDE5D4] text-[#3C3A34] rounded text-xs font-semibold transition-colors border border-[#D9D2C2]">
                      <Phone className="w-3 h-3 text-[#6B6860]" />
                      Call
                    </button>
                    <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#F5F2EB] hover:bg-[#EDE5D4] text-[#3C3A34] rounded text-xs font-semibold transition-colors border border-[#D9D2C2]">
                      <Mail className="w-3 h-3 text-[#6B6860]" />
                      Email
                    </button>
                    <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#F3EAFF] hover:bg-[#e4d4ff] text-[#6A12D9] rounded text-xs font-semibold transition-colors border border-[#d2b1ff] ml-auto">
                      Stage
                      <ChevronDown className="w-3 h-3 opacity-60" />
                    </button>
                    <button className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#200842] hover:bg-[#3d0f7a] text-white rounded text-xs font-semibold transition-colors shadow-sm">
                      Open
                      <ExternalLink className="w-3 h-3 opacity-80" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content Area Placeholder */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-[#F5EFE0]">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="w-16 h-16 bg-[#EDE5D4] rounded-2xl mx-auto flex items-center justify-center border border-[#D9D2C2] shadow-sm rotate-3">
            <Search className="w-8 h-8 text-[#97927F] -rotate-3" />
          </div>
          <h2 className="text-2xl font-bold text-[#200842]">Select a customer</h2>
          <p className="text-[#6B6860] leading-relaxed">
            Choose a customer from the expanded list on the left to view their complete profile, project details, and communication history.
          </p>
        </div>
      </div>
    </div>
  );
}
