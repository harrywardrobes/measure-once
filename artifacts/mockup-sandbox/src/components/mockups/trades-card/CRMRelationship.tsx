import React, { useState } from "react";
import { 
  Search, ExternalLink, Edit2, Phone, Mail, MessageSquare, 
  MapPin, Clock, Star, Globe, FileText 
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Contact = {
  name: string; role: string; phone?: string; email?: string;
  preferred: "phone" | "email" | "text" | "phone+email";
};

type Trade = {
  id: string; companyName: string; tradeType: string; areasServed: string[];
  contacts: Contact[]; leadTime: string; phone: string;
  website?: string; notes?: string;
  addedBy: string; addedDate: string; editedBy?: string; editedDate?: string;
};

const trades: Trade[] = [
  {
    id: "1", companyName: "Apex Electrical", tradeType: "Electrical", areasServed: ["North Shore", "CBD"],
    contacts: [{ name: "Dan Carter", role: "Estimator", phone: "0412 345 678", email: "dan@apexelectrical.com.au", preferred: "phone" }],
    leadTime: "2–3 wks", phone: "(02) 9123 4567", website: "www.apexelectrical.com.au",
    addedBy: "Sarah Jenkins", addedDate: "12 Oct 2023", editedBy: "Mike Ross", editedDate: "05 Nov 2023"
  },
  {
    id: "2", companyName: "BlueLine Plumbing", tradeType: "Plumbing", areasServed: ["Inner West", "CBD"],
    contacts: [{ name: "Mei Lin", role: "Director", phone: "0499 888 777", email: "mei@bluelineplumbing.com.au", preferred: "email" }],
    leadTime: "1 wk", phone: "(02) 8888 9999",
    addedBy: "Sarah Jenkins", addedDate: "14 Oct 2023"
  },
  {
    id: "3", companyName: "Summit Carpentry", tradeType: "Carpentry", areasServed: ["All Sydney"],
    contacts: [{ name: "Chris Payne", role: "Owner", phone: "0455 444 333", email: "chris@summitcarpentry.com", preferred: "phone+email" }],
    leadTime: "3–4 wks", phone: "(02) 7777 6666", website: "summitcarpentry.com",
    addedBy: "Mike Ross", addedDate: "20 Oct 2023"
  },
  {
    id: "4", companyName: "Ironclad Steel", tradeType: "Structural Steel", areasServed: ["City", "North Shore"],
    contacts: [{ name: "Tom Wells", role: "PM", phone: "0422 111 000", email: "tom.w@ironclad.com.au", preferred: "text" }],
    leadTime: "4–6 wks", phone: "(02) 5555 4444", notes: "Cert III on file. Preferred for large beams.",
    addedBy: "Sarah Jenkins", addedDate: "01 Nov 2023"
  },
  {
    id: "5", companyName: "Pacific Concrete", tradeType: "Concrete", areasServed: ["Western Sydney"],
    contacts: [{ name: "Ana Torres", role: "Operations", phone: "0411 222 333", email: "ana@pacificconcrete.com.au", preferred: "email" }],
    leadTime: "1–2 wks", phone: "(02) 4444 3333", website: "pacificconcrete.com.au",
    addedBy: "Mike Ross", addedDate: "10 Nov 2023"
  }
];

const TRADE_COLORS: Record<string, string> = {
  "Electrical": "bg-amber-400",
  "Plumbing": "bg-blue-500",
  "Carpentry": "bg-orange-500",
  "Structural Steel": "bg-slate-600",
  "Concrete": "bg-stone-400",
};

const TRADE_BADGES: Record<string, string> = {
  "Electrical": "bg-amber-50 text-amber-700 border-amber-200",
  "Plumbing": "bg-blue-50 text-blue-700 border-blue-200",
  "Carpentry": "bg-orange-50 text-orange-700 border-orange-200",
  "Structural Steel": "bg-slate-100 text-slate-700 border-slate-200",
  "Concrete": "bg-stone-100 text-stone-700 border-stone-200",
};

export function CRMRelationship() {
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState("All");

  const filteredTrades = trades.filter(t => {
    const matchesSearch = t.companyName.toLowerCase().includes(search.toLowerCase()) || 
                          t.contacts.some(c => c.name.toLowerCase().includes(search.toLowerCase()));
    const matchesTab = activeTab === "All" || t.tradeType === activeTab;
    return matchesSearch && matchesTab;
  });

  const tabs = ["All", "Electrical", "Plumbing", "Carpentry", "Structural Steel", "Concrete"];

  return (
    <div className="w-full max-w-5xl mx-auto p-6 bg-slate-50 min-h-screen font-sans">
      <div className="mb-8 space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Vendors & Trades</h1>
          <p className="text-sm text-slate-500 mt-1">Manage your trusted subcontractors and vendor relationships.</p>
        </div>
        
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex bg-slate-200/50 p-1 rounded-md overflow-x-auto w-full sm:w-auto">
            {tabs.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1.5 text-sm font-medium rounded-sm whitespace-nowrap transition-colors ${
                  activeTab === tab 
                    ? "bg-white text-slate-900 shadow-sm" 
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/50"
                }`}
              >
                {tab === "Structural Steel" ? "Steel" : tab}
              </button>
            ))}
          </div>
          
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
            <Input 
              type="text" 
              placeholder="Search trades or contacts..." 
              className="pl-9 bg-white"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {filteredTrades.map(trade => (
          <div 
            key={trade.id} 
            className="group relative flex flex-col bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden hover:shadow-md transition-shadow"
          >
            {/* Left Color Bar */}
            <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${TRADE_COLORS[trade.tradeType] || "bg-slate-300"}`} />
            
            <div className="flex flex-col sm:flex-row w-full p-4 pl-6 gap-6">
              
              {/* Left Column: Company Info (30%) */}
              <div className="flex-shrink-0 sm:w-[30%] flex flex-col justify-center space-y-2">
                <div>
                  <h3 className="text-base font-semibold text-slate-900 leading-tight">
                    {trade.companyName}
                  </h3>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Badge variant="outline" className={`text-xs px-2 py-0 h-5 font-medium ${TRADE_BADGES[trade.tradeType]}`}>
                      {trade.tradeType}
                    </Badge>
                  </div>
                </div>
                
                <div className="flex items-center text-xs text-slate-500">
                  <MapPin className="h-3 w-3 mr-1" />
                  <span className="truncate">{trade.areasServed.join(", ")}</span>
                </div>
              </div>

              {/* Middle Column: Contacts (40%) */}
              <div className="flex-1 sm:w-[40%] flex flex-col justify-center">
                <div className="flex flex-wrap gap-2">
                  {trade.contacts.map((contact, idx) => (
                    <Popover key={idx}>
                      <PopoverTrigger asChild>
                        <button className="flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-slate-50 border border-slate-200 hover:border-slate-300 hover:bg-slate-100 transition-colors text-left focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1">
                          <Avatar className="h-6 w-6 border border-white shadow-sm">
                            <AvatarFallback className="bg-slate-200 text-slate-600 text-[10px] font-semibold">
                              {contact.name.split(' ').map(n => n[0]).join('')}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex flex-col">
                            <span className="text-xs font-medium text-slate-900 leading-none flex items-center gap-1">
                              {contact.name}
                              {["phone", "phone+email", "email"].includes(contact.preferred) && (
                                <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                              )}
                            </span>
                            <span className="text-[10px] text-slate-500 mt-0.5 leading-none">{contact.role}</span>
                          </div>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-3 shadow-lg rounded-xl" align="start">
                        <div className="flex items-center gap-3 mb-3 pb-3 border-b border-slate-100">
                          <Avatar className="h-10 w-10">
                            <AvatarFallback className="bg-slate-100 text-slate-600 text-xs font-semibold">
                              {contact.name.split(' ').map(n => n[0]).join('')}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-sm font-semibold text-slate-900 leading-none">{contact.name}</p>
                            <p className="text-xs text-slate-500 mt-1">{contact.role} at {trade.companyName}</p>
                          </div>
                        </div>
                        
                        <div className="space-y-2">
                          {contact.phone && (
                            <Button variant="outline" size="sm" className="w-full justify-start text-xs h-8">
                              <Phone className="h-3 w-3 mr-2 text-slate-400" />
                              {contact.phone}
                              {(contact.preferred === "phone" || contact.preferred === "phone+email") && 
                                <Badge variant="secondary" className="ml-auto text-[9px] h-4 px-1 py-0">Preferred</Badge>
                              }
                            </Button>
                          )}
                          {contact.phone && (
                            <Button variant="outline" size="sm" className="w-full justify-start text-xs h-8">
                              <MessageSquare className="h-3 w-3 mr-2 text-slate-400" />
                              Send SMS
                              {contact.preferred === "text" && 
                                <Badge variant="secondary" className="ml-auto text-[9px] h-4 px-1 py-0">Preferred</Badge>
                              }
                            </Button>
                          )}
                          {contact.email && (
                            <Button variant="outline" size="sm" className="w-full justify-start text-xs h-8">
                              <Mail className="h-3 w-3 mr-2 text-slate-400" />
                              {contact.email}
                              {(contact.preferred === "email" || contact.preferred === "phone+email") && 
                                <Badge variant="secondary" className="ml-auto text-[9px] h-4 px-1 py-0">Preferred</Badge>
                              }
                            </Button>
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  ))}
                </div>
                
                {/* Optional Metadata */}
                {(trade.website || trade.notes) && (
                  <div className="mt-3 space-y-1">
                    {trade.notes && (
                      <div className="flex items-start text-xs text-slate-500">
                        <FileText className="h-3 w-3 mr-1.5 mt-0.5 flex-shrink-0" />
                        <span className="line-clamp-1 italic">"{trade.notes}"</span>
                      </div>
                    )}
                    {trade.website && (
                      <div className="flex items-center text-xs text-blue-600 hover:underline cursor-pointer">
                        <Globe className="h-3 w-3 mr-1.5" />
                        <span>{trade.website}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right Column: Actions & Meta (30%) */}
              <div className="flex-shrink-0 sm:w-[30%] flex flex-col items-end justify-center space-y-3 border-t sm:border-t-0 sm:border-l border-slate-100 pt-3 sm:pt-0 sm:pl-6">
                <div className="w-full flex justify-between items-center sm:justify-end sm:gap-4">
                  <div className="flex flex-col items-start sm:items-end">
                    <div className="flex items-center text-xs font-medium text-slate-700 bg-slate-100 px-2 py-1 rounded-md mb-1">
                      <Clock className="h-3 w-3 mr-1.5 text-slate-500" />
                      Lead: {trade.leadTime}
                    </div>
                    <span className="text-[10px] text-slate-400">
                      Last contacted: <span className="font-medium text-slate-500">3 wks ago</span>
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-slate-900">
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-slate-900">
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

            </div>
            
            {/* Audit Line */}
            <div className="bg-slate-50/50 px-6 py-1.5 border-t border-slate-100 text-[10px] text-slate-400 flex items-center justify-between">
              <span>Added by {trade.addedBy} on {trade.addedDate}</span>
              {trade.editedBy && (
                <span>Last edited by {trade.editedBy} on {trade.editedDate}</span>
              )}
            </div>
          </div>
        ))}
        
        {filteredTrades.length === 0 && (
          <div className="text-center py-12 bg-white rounded-xl border border-slate-200 border-dashed">
            <h3 className="text-sm font-medium text-slate-900">No trades found</h3>
            <p className="text-xs text-slate-500 mt-1">Try adjusting your search or filters.</p>
          </div>
        )}
      </div>
    </div>
  );
}
