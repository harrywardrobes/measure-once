import React, { useState } from "react";
import { 
  Phone, 
  Mail, 
  MessageSquare, 
  Copy, 
  MapPin, 
  Clock, 
  Globe, 
  Wrench, 
  Zap, 
  Droplet,
  Hammer,
  Building2,
  Pencil,
  Trash2,
  Plus,
  Search,
  Filter,
  CheckCircle2
} from "lucide-react";

export function AccessibilityReadability() {
  const [searchTerm, setSearchTerm] = useState("");
  const [tradeFilter, setTradeFilter] = useState("all");

  const trades = [
    {
      id: "1",
      name: "Apex Electrical",
      tradeType: "Electrical",
      areasServed: "North Shore, CBD",
      leadTime: "2–3 weeks",
      phone: "(02) 9123 4567",
      website: "apex-electrical.com.au",
      contacts: [
        {
          name: "Dan Carter",
          role: "Estimator",
          pref: "Phone",
          phone: "0412 345 678",
          email: "dan@apex-electrical.com.au"
        }
      ],
      notes: "",
      addedBy: "Sarah Jenkins",
      addedDate: "12 January 2026",
      editedBy: "Sarah Jenkins",
      editedDate: "15 January 2026"
    },
    {
      id: "2",
      name: "BlueLine Plumbing",
      tradeType: "Plumbing",
      areasServed: "Inner West, CBD",
      leadTime: "1 week",
      phone: "(02) 8877 6655",
      website: "bluelineplumbing.com.au",
      contacts: [
        {
          name: "Mei Lin",
          role: "Director",
          pref: "Email",
          phone: "0422 111 222",
          email: "mei@bluelineplumbing.com.au"
        }
      ],
      notes: "",
      addedBy: "Mark Thomas",
      addedDate: "05 November 2025",
      editedBy: "",
      editedDate: ""
    },
    {
      id: "3",
      name: "Summit Carpentry",
      tradeType: "Carpentry",
      areasServed: "All Sydney",
      leadTime: "3–4 weeks",
      phone: "(02) 9988 7766",
      website: "summitcarpentry.com.au",
      contacts: [
        {
          name: "Chris Payne",
          role: "Owner",
          pref: "Phone + Email",
          phone: "0433 444 555",
          email: "chris@summitcarpentry.com.au"
        }
      ],
      notes: "",
      addedBy: "Sarah Jenkins",
      addedDate: "20 December 2025",
      editedBy: "Mark Thomas",
      editedDate: "02 January 2026"
    },
    {
      id: "4",
      name: "Ironclad Steel",
      tradeType: "Structural Steel",
      areasServed: "City, North Shore",
      leadTime: "2 weeks",
      phone: "(02) 9000 1111",
      website: "ironcladsteel.com.au",
      contacts: [
        {
          name: "Tom Wells",
          role: "PM",
          pref: "Text",
          phone: "0455 666 777",
          email: "tom@ironcladsteel.com.au"
        }
      ],
      notes: "Cert III on file. Preferred for large beams.",
      addedBy: "Admin User",
      addedDate: "10 January 2026",
      editedBy: "",
      editedDate: ""
    }
  ];

  const getTradeIcon = (type: string) => {
    switch(type) {
      case "Electrical": return <Zap className="w-5 h-5 text-amber-700" aria-hidden="true" />;
      case "Plumbing": return <Droplet className="w-5 h-5 text-blue-700" aria-hidden="true" />;
      case "Carpentry": return <Hammer className="w-5 h-5 text-orange-700" aria-hidden="true" />;
      case "Structural Steel": return <Building2 className="w-5 h-5 text-slate-700" aria-hidden="true" />;
      default: return <Wrench className="w-5 h-5 text-gray-700" aria-hidden="true" />;
    }
  };

  const getPrefIcon = (pref: string) => {
    if (pref.includes("Phone")) return <Phone className="w-4 h-4" aria-hidden="true" />;
    if (pref.includes("Email")) return <Mail className="w-4 h-4" aria-hidden="true" />;
    if (pref.includes("Text")) return <MessageSquare className="w-4 h-4" aria-hidden="true" />;
    return <CheckCircle2 className="w-4 h-4" aria-hidden="true" />;
  };

  return (
    <div className="min-h-screen bg-stone-100 font-sans text-slate-900 pb-20">
      {/* Sticky Filter Bar */}
      <header className="sticky top-0 z-10 bg-white border-b border-stone-300 shadow-sm px-6 py-5">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row gap-6 justify-between items-start md:items-end">
          <div className="flex flex-col sm:flex-row gap-5 w-full md:w-auto">
            {/* Filter by Trade */}
            <div className="flex flex-col gap-2">
              <label htmlFor="trade-filter" className="text-[15px] font-semibold text-slate-800">
                Filter by trade category
              </label>
              <div className="relative">
                <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-600" aria-hidden="true" />
                <select 
                  id="trade-filter"
                  className="pl-10 pr-10 py-3 text-[16px] w-full sm:w-64 border-2 border-stone-300 rounded-lg bg-stone-50 text-slate-900 focus:border-blue-600 focus:ring-4 focus:ring-blue-600/20 focus:outline-none appearance-none transition-colors"
                  value={tradeFilter}
                  onChange={(e) => setTradeFilter(e.target.value)}
                >
                  <option value="all">All Trade Categories</option>
                  <option value="electrical">Electrical</option>
                  <option value="plumbing">Plumbing</option>
                  <option value="carpentry">Carpentry</option>
                  <option value="steel">Structural Steel</option>
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-600">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </div>
              </div>
            </div>

            {/* Filter by Area */}
            <div className="flex flex-col gap-2">
              <label htmlFor="area-filter" className="text-[15px] font-semibold text-slate-800">
                Filter by service area
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-600" aria-hidden="true" />
                <input 
                  id="area-filter"
                  type="text" 
                  placeholder="e.g. North Shore, CBD..."
                  className="pl-10 pr-4 py-3 text-[16px] w-full sm:w-72 border-2 border-stone-300 rounded-lg bg-stone-50 text-slate-900 placeholder:text-slate-500 focus:border-blue-600 focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
          </div>

          <button className="flex items-center justify-center gap-2 bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 px-6 rounded-lg min-h-[48px] focus:ring-4 focus:ring-blue-600/40 focus:outline-none transition-colors w-full md:w-auto shadow-sm">
            <Plus className="w-5 h-5" aria-hidden="true" />
            <span>Add Subcontractor</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-10">
        <h1 className="sr-only">Trades Directory</h1>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {trades.map((trade) => (
            <article 
              key={trade.id} 
              className="bg-[#FAFAF8] border-2 border-stone-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow relative group"
            >
              {/* Card Header */}
              <div className="p-6 border-b border-stone-200 bg-white">
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <h2 className="text-2xl font-bold text-slate-900 mb-3 tracking-tight leading-tight">
                      {trade.name}
                    </h2>
                    <div className="flex flex-wrap items-center gap-3">
                      {/* Trade Type Badge - Dual encoding (Icon + Color + Text) */}
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-100 border border-slate-300 text-slate-800 rounded-full text-[15px] font-medium shadow-sm">
                        {getTradeIcon(trade.tradeType)}
                        <span>{trade.tradeType}</span>
                      </div>
                      
                      {/* Lead Time Pill */}
                      <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-full text-[15px] font-medium shadow-sm">
                        <Clock className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                        <span>Lead time: {trade.leadTime}</span>
                      </div>
                    </div>
                  </div>
                  
                  {/* Actions (Edit/Delete) */}
                  <div className="flex gap-2">
                    <button 
                      className="p-3 text-slate-600 hover:text-blue-700 hover:bg-blue-50 border border-transparent hover:border-blue-200 rounded-lg min-w-[44px] min-h-[44px] flex items-center justify-center focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors"
                      aria-label={`Edit ${trade.name}`}
                      title="Edit"
                    >
                      <Pencil className="w-5 h-5" aria-hidden="true" />
                    </button>
                    <button 
                      className="p-3 text-slate-600 hover:text-red-700 hover:bg-red-50 border border-transparent hover:border-red-200 rounded-lg min-w-[44px] min-h-[44px] flex items-center justify-center focus:ring-4 focus:ring-red-600/20 focus:outline-none transition-colors"
                      aria-label={`Delete ${trade.name}`}
                      title="Delete"
                    >
                      <Trash2 className="w-5 h-5" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex items-start gap-2 text-[16px] text-slate-700">
                  <MapPin className="w-5 h-5 mt-0.5 text-slate-500 shrink-0" aria-hidden="true" />
                  <p><strong className="font-semibold text-slate-900">Areas served:</strong> {trade.areasServed}</p>
                </div>
              </div>

              {/* Card Body */}
              <div className="p-6 space-y-6">
                
                {/* Company Details */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[14px] font-bold text-slate-600 uppercase tracking-wider">Company Phone</span>
                    <div className="flex items-center gap-2">
                      <span className="text-[16px] font-medium text-slate-900">{trade.phone}</span>
                      <button 
                        className="p-2 text-blue-700 hover:bg-blue-100 rounded-md min-w-[44px] min-h-[44px] flex items-center justify-center focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors"
                        aria-label={`Copy company phone number for ${trade.name}`}
                        title="Copy phone"
                      >
                        <Copy className="w-5 h-5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[14px] font-bold text-slate-600 uppercase tracking-wider">Website</span>
                    <div className="flex items-center gap-2">
                      <a 
                        href={`https://${trade.website}`} 
                        target="_blank" 
                        rel="noreferrer"
                        className="text-[16px] font-medium text-blue-700 hover:text-blue-900 underline underline-offset-4 focus:ring-4 focus:ring-blue-600/20 focus:outline-none rounded-sm"
                      >
                        {trade.website}
                      </a>
                      <button 
                        className="p-2 text-blue-700 hover:bg-blue-100 rounded-md min-w-[44px] min-h-[44px] flex items-center justify-center focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors"
                        aria-label={`Copy website URL for ${trade.name}`}
                        title="Copy website"
                      >
                        <Copy className="w-5 h-5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Contacts */}
                <div className="border-t border-stone-200 pt-6">
                  <h3 className="text-[18px] font-bold text-slate-900 mb-4 flex items-center gap-2">
                    Primary Contacts
                  </h3>
                  
                  <div className="space-y-6">
                    {trade.contacts.map((contact, i) => (
                      <div key={i} className="bg-white border border-stone-200 p-5 rounded-lg shadow-sm">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                          <div>
                            <p className="text-[18px] font-bold text-slate-900">{contact.name}</p>
                            <p className="text-[16px] text-slate-600 mt-0.5">{contact.role}</p>
                          </div>
                          
                          {/* Explicit Preference Chip */}
                          <div className="inline-flex items-center gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 text-indigo-900 rounded-md text-[15px] font-medium">
                            {getPrefIcon(contact.pref)}
                            <span>Prefers {contact.pref}</span>
                          </div>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-3">
                          <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <button className="flex-1 flex items-center justify-center gap-2 bg-stone-100 hover:bg-stone-200 border border-stone-300 text-slate-800 font-semibold py-2.5 px-4 rounded-lg min-h-[44px] focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors">
                              <Phone className="w-5 h-5" aria-hidden="true" />
                              <span className="text-[16px]">Call {contact.phone}</span>
                            </button>
                            <button 
                              className="hidden sm:flex p-2.5 text-slate-600 hover:bg-stone-200 border border-stone-300 rounded-lg min-w-[44px] min-h-[44px] items-center justify-center focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors"
                              aria-label={`Copy phone for ${contact.name}`}
                              title="Copy"
                            >
                              <Copy className="w-5 h-5" aria-hidden="true" />
                            </button>
                          </div>
                          
                          <div className="flex-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <button className="flex-1 flex items-center justify-center gap-2 bg-stone-100 hover:bg-stone-200 border border-stone-300 text-slate-800 font-semibold py-2.5 px-4 rounded-lg min-h-[44px] focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors">
                              <Mail className="w-5 h-5" aria-hidden="true" />
                              <span className="text-[16px]">Email {contact.name.split(' ')[0]}</span>
                            </button>
                            <button 
                              className="hidden sm:flex p-2.5 text-slate-600 hover:bg-stone-200 border border-stone-300 rounded-lg min-w-[44px] min-h-[44px] items-center justify-center focus:ring-4 focus:ring-blue-600/20 focus:outline-none transition-colors"
                              aria-label={`Copy email for ${contact.name}`}
                              title="Copy"
                            >
                              <Copy className="w-5 h-5" aria-hidden="true" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Notes Block */}
                {trade.notes && (
                  <div className="bg-amber-50 border-l-4 border-amber-500 p-4 rounded-r-lg mt-2">
                    <p className="text-[14px] font-bold text-amber-900 uppercase tracking-wider mb-1">Notes</p>
                    <p className="text-[16px] text-amber-950 leading-relaxed">{trade.notes}</p>
                  </div>
                )}
              </div>

              {/* Audit Row */}
              <div className="bg-stone-100 border-t border-stone-200 p-4 text-[14px] text-slate-600 flex flex-col sm:flex-row justify-between gap-2">
                <p>Added by <strong className="font-semibold text-slate-800">{trade.addedBy}</strong> on {trade.addedDate}</p>
                {trade.editedBy && (
                  <p>Last edited by <strong className="font-semibold text-slate-800">{trade.editedBy}</strong> on {trade.editedDate}</p>
                )}
              </div>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
