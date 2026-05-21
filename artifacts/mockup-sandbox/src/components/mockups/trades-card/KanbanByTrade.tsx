import React, { useState } from "react";
import { 
  Search, Filter, Plus, Phone, Mail, MapPin, Clock, MessageSquare 
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

type Contact = {
  name: string;
  role: string;
  phone?: string;
  email?: string;
  preferred: "phone" | "email" | "text" | "phone+email";
};

type Trade = {
  id: string;
  companyName: string;
  tradeType: string;
  areasServed: string[];
  contacts: Contact[];
  leadTime: string;
  phone: string;
  website?: string;
  notes?: string;
  addedBy: string;
  addedDate: string;
  editedBy?: string;
  editedDate?: string;
};

const TRADES_DATA: Trade[] = [
  {
    id: "1",
    companyName: "Apex Electrical",
    tradeType: "Electrical",
    areasServed: ["North Shore", "CBD"],
    contacts: [
      { name: "Dan Carter", role: "Estimator", preferred: "phone", phone: "0412 345 678", email: "dan@apexelectrical.com.au" }
    ],
    leadTime: "2–3 wks",
    phone: "(02) 9123 4567",
    website: "www.apexelectrical.com.au",
    addedBy: "Sarah Jenkins",
    addedDate: "12 Oct 2023",
    editedBy: "Mike Ross",
    editedDate: "05 Nov 2023"
  },
  {
    id: "2",
    companyName: "BlueLine Plumbing",
    tradeType: "Plumbing",
    areasServed: ["Inner West", "CBD"],
    contacts: [
      { name: "Mei Lin", role: "Director", preferred: "email", phone: "0499 888 777", email: "mei@bluelineplumbing.com.au" }
    ],
    leadTime: "1 wk",
    phone: "(02) 8888 9999",
    addedBy: "Sarah Jenkins",
    addedDate: "14 Oct 2023"
  },
  {
    id: "3",
    companyName: "Summit Carpentry",
    tradeType: "Carpentry",
    areasServed: ["All Sydney"],
    contacts: [
      { name: "Chris Payne", role: "Owner", preferred: "phone+email", phone: "0455 444 333", email: "chris@summitcarpentry.com" }
    ],
    leadTime: "3–4 wks",
    phone: "(02) 7777 6666",
    website: "summitcarpentry.com",
    addedBy: "Mike Ross",
    addedDate: "20 Oct 2023"
  },
  {
    id: "4",
    companyName: "Ironclad Steel",
    tradeType: "Structural Steel",
    areasServed: ["City", "North Shore"],
    contacts: [
      { name: "Tom Wells", role: "PM", preferred: "text", phone: "0422 111 000", email: "tom.w@ironclad.com.au" }
    ],
    leadTime: "4–6 wks",
    phone: "(02) 5555 4444",
    notes: "Cert III on file. Preferred for large beams.",
    addedBy: "Sarah Jenkins",
    addedDate: "01 Nov 2023"
  },
  {
    id: "5",
    companyName: "Pacific Concrete",
    tradeType: "Concrete",
    areasServed: ["Western Sydney"],
    contacts: [
      { name: "Ana Torres", role: "Operations", preferred: "email", phone: "0411 222 333", email: "ana@pacificconcrete.com.au" }
    ],
    leadTime: "1–2 wks",
    phone: "(02) 4444 3333",
    website: "pacificconcrete.com.au",
    addedBy: "Mike Ross",
    addedDate: "10 Nov 2023"
  }
];

const TRADE_CATEGORIES = [
  "Electrical",
  "Plumbing",
  "Carpentry",
  "Structural Steel",
  "Concrete",
  "Fire Protection"
];

const TRADE_COLORS: Record<string, string> = {
  "Electrical": "bg-yellow-500",
  "Plumbing": "bg-blue-500",
  "Carpentry": "bg-amber-600",
  "Structural Steel": "bg-slate-700",
  "Concrete": "bg-stone-500",
  "Fire Protection": "bg-red-600"
};

export function KanbanByTrade() {
  const [search, setSearch] = useState("");
  const [groupBy, setGroupBy] = useState<"trade" | "area">("trade");

  // Filter logic (simple)
  const filteredTrades = TRADES_DATA.filter(t => 
    t.companyName.toLowerCase().includes(search.toLowerCase()) ||
    t.tradeType.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans">
      {/* Header & Filter Bar */}
      <header className="bg-white border-b px-6 py-4 flex flex-col gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Trade Directory</h1>
          <p className="text-sm text-slate-500">Manage and contact your subcontractors</p>
        </div>
        
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
              <Input 
                placeholder="Search trades, companies..." 
                className="pl-9 bg-slate-50 border-slate-200"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button variant="outline" className="gap-2">
              <Filter className="h-4 w-4" />
              Filter Areas
            </Button>
          </div>
          
          <div className="flex items-center bg-slate-100 p-1 rounded-lg">
            <button 
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${groupBy === "trade" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              onClick={() => setGroupBy("trade")}
            >
              By Trade Type
            </button>
            <button 
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${groupBy === "area" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              onClick={() => setGroupBy("area")}
            >
              By Area
            </button>
          </div>
        </div>
      </header>

      {/* Kanban Board */}
      <main className="flex-1 overflow-x-auto overflow-y-hidden p-6">
        <div className="flex gap-6 h-full items-start">
          {TRADE_CATEGORIES.map(category => {
            const columnTrades = filteredTrades.filter(t => t.tradeType === category);
            const colorClass = TRADE_COLORS[category] || "bg-slate-400";
            
            return (
              <div 
                key={category} 
                className="flex flex-col flex-shrink-0 w80 w-[340px] max-h-full bg-slate-100/80 border border-slate-200 rounded-xl overflow-hidden shadow-sm"
              >
                {/* Column Header */}
                <div className={`h-1.5 w-full ${colorClass}`} />
                <div className="px-4 py-3 bg-white border-b border-slate-200 flex items-center justify-between sticky top-0 z-10">
                  <h2 className="font-semibold text-slate-800">{category}</h2>
                  <Badge variant="secondary" className="bg-slate-100 text-slate-600 hover:bg-slate-100">
                    {columnTrades.length}
                  </Badge>
                </div>

                {/* Column Body */}
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {columnTrades.length > 0 ? (
                    columnTrades.map(trade => (
                      <TradeCard key={trade.id} trade={trade} />
                    ))
                  ) : (
                    <div className="h-24 flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-lg bg-slate-50/50">
                      <p className="text-sm text-slate-500 font-medium">No subs yet</p>
                      <p className="text-xs text-slate-400 mt-1">Click below to add one</p>
                    </div>
                  )}
                </div>

                {/* Column Footer / Add Button */}
                <div className="p-3 bg-slate-50 border-t border-slate-200 mt-auto">
                  <Button variant="ghost" className="w-full justify-start text-slate-500 hover:text-slate-800 hover:bg-slate-200/50">
                    <Plus className="h-4 w-4 mr-2" />
                    Add {category} Sub
                  </Button>
                </div>
              </div>
            );
          })}
          
          {/* Add Column Button */}
          <div className="flex-shrink-0 w-[340px] h-full flex flex-col">
             <Button variant="outline" className="w-full h-12 border-dashed border-2 text-slate-500 bg-transparent hover:bg-white">
               <Plus className="h-4 w-4 mr-2" />
               Add Trade Category
             </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

function TradeCard({ trade }: { trade: Trade }) {
  const primaryContact = trade.contacts[0];
  
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing group">
      <div className="flex justify-between items-start mb-1">
        <h3 className="font-semibold text-slate-900 leading-tight group-hover:text-blue-600 transition-colors">
          {trade.companyName}
        </h3>
        <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0">
          {trade.leadTime} lead
        </Badge>
      </div>
      
      {primaryContact && (
        <div className="mb-3">
          <p className="text-sm font-medium text-slate-700">
            {primaryContact.name} <span className="text-slate-400 font-normal ml-1">· {primaryContact.role}</span>
          </p>
        </div>
      )}
      
      <div className="flex items-center text-xs text-slate-500 mb-4 mt-2 bg-slate-50 rounded-md p-1.5 w-max">
        <MapPin className="h-3.5 w-3.5 mr-1.5 text-slate-400" />
        <span className="truncate max-w-[200px]">{trade.areasServed.join(", ")}</span>
      </div>
      
      <div className="flex gap-2 mt-auto">
        <Button variant="outline" size="sm" className="flex-1 h-8 text-xs font-medium border-slate-200 hover:bg-slate-50 hover:text-slate-900">
          <Phone className="h-3.5 w-3.5 mr-1.5 text-blue-600" />
          Call
        </Button>
        <Button variant="outline" size="sm" className="flex-1 h-8 text-xs font-medium border-slate-200 hover:bg-slate-50 hover:text-slate-900">
          <Mail className="h-3.5 w-3.5 mr-1.5 text-blue-600" />
          Email
        </Button>
      </div>
    </div>
  );
}
