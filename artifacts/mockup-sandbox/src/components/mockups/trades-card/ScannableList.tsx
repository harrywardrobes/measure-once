import React, { useState } from "react";
import { 
  Phone, Mail, MessageSquare, Globe, Clock, ChevronDown, ChevronUp,
  Search, Filter, ArrowUpDown, Copy, Plus, FileText, Calendar
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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

const TRADES: Trade[] = [
  {
    id: "1",
    companyName: "Apex Electrical",
    tradeType: "Electrical",
    areasServed: ["North Shore", "CBD"],
    contacts: [{ name: "Dan Carter", role: "Estimator", preferred: "phone", phone: "0412 345 678", email: "dan@apexelectrical.com.au" }],
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
    contacts: [{ name: "Mei Lin", role: "Director", preferred: "email", phone: "0499 888 777", email: "mei@bluelineplumbing.com.au" }],
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
    contacts: [{ name: "Chris Payne", role: "Owner", preferred: "phone+email", phone: "0455 444 333", email: "chris@summitcarpentry.com" }],
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
    contacts: [{ name: "Tom Wells", role: "PM", preferred: "text", phone: "0422 111 000", email: "tom.w@ironclad.com.au" }],
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
    contacts: [{ name: "Ana Torres", role: "Operations", preferred: "email", phone: "0411 222 333", email: "ana@pacificconcrete.com.au" }],
    leadTime: "1–2 wks",
    phone: "(02) 4444 3333",
    website: "pacificconcrete.com.au",
    addedBy: "Mike Ross",
    addedDate: "10 Nov 2023"
  }
];

export function ScannableList() {
  const [expandedRow, setExpandedRow] = useState<string | null>("1");

  const toggleRow = (id: string) => {
    setExpandedRow(prev => prev === id ? null : id);
  };

  return (
    <div className="w-full max-w-5xl mx-auto font-sans bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden flex flex-col h-full max-h-[800px]">
      {/* Header / Filter Bar */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 bg-gray-50/50">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input 
            placeholder="Search trades..." 
            className="pl-9 h-9 bg-white text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-gray-600 bg-white">
            <Filter className="h-4 w-4" />
            Category
          </Button>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-gray-600 bg-white">
            <Filter className="h-4 w-4" />
            Area
          </Button>
          <Button size="sm" className="h-9 gap-1.5 bg-gray-900 text-white hover:bg-gray-800 ml-2">
            <Plus className="h-4 w-4" />
            Add Trade
          </Button>
        </div>
      </div>

      {/* Table Structure */}
      <div className="flex flex-col flex-1 overflow-auto">
        {/* Table Header */}
        <div className="grid grid-cols-[3fr_2fr_3fr_2fr_1fr] gap-4 px-4 py-3 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider sticky top-0 z-10">
          <div className="flex items-center gap-1 cursor-pointer hover:text-gray-700">Company <ArrowUpDown className="h-3 w-3" /></div>
          <div>Trade</div>
          <div>Areas</div>
          <div className="flex items-center gap-1 cursor-pointer hover:text-gray-700">Lead Time <ArrowUpDown className="h-3 w-3" /></div>
          <div className="text-right">Actions</div>
        </div>

        {/* Table Body */}
        <div className="flex flex-col">
          {TRADES.map((trade, index) => {
            const isExpanded = expandedRow === trade.id;
            return (
              <React.Fragment key={trade.id}>
                {/* Collapsed Row View */}
                <div 
                  className={cn(
                    "grid grid-cols-[3fr_2fr_3fr_2fr_1fr] gap-4 px-4 py-3 items-center text-sm border-b border-gray-100 transition-colors cursor-pointer group hover:bg-gray-50",
                    index % 2 === 1 && !isExpanded ? "bg-gray-50/50" : "bg-white",
                    isExpanded ? "bg-blue-50/40 border-b-blue-100" : ""
                  )}
                  onClick={() => toggleRow(trade.id)}
                >
                  <div className="font-medium text-gray-900 truncate pr-4">
                    {trade.companyName}
                  </div>
                  <div>
                    <Badge variant="secondary" className="font-normal text-xs bg-gray-100 text-gray-700 hover:bg-gray-200">
                      {trade.tradeType}
                    </Badge>
                  </div>
                  <div className="text-gray-500 truncate pr-4 text-xs">
                    {trade.areasServed.join(", ")}
                  </div>
                  <div>
                    <div className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 bg-white border border-gray-200 px-2 py-0.5 rounded-full shadow-sm">
                      <Clock className="h-3 w-3 text-gray-400" />
                      {trade.leadTime}
                    </div>
                  </div>
                  <div className="flex justify-end gap-1 items-center text-gray-400">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-900 hover:bg-gray-100 hidden group-hover:flex" onClick={(e) => { e.stopPropagation(); }}>
                      <Phone className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-gray-400 hover:text-gray-900 hover:bg-gray-100 hidden group-hover:flex" onClick={(e) => { e.stopPropagation(); }}>
                      <Mail className="h-4 w-4" />
                    </Button>
                    <div className="h-8 w-8 flex items-center justify-center group-hover:hidden">
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </div>
                  </div>
                </div>

                {/* Expanded Panel */}
                {isExpanded && (
                  <div className="bg-blue-50/30 border-b border-gray-200 overflow-hidden text-sm">
                    <div className="p-5 pl-8 grid grid-cols-[1fr_300px] gap-8">
                      {/* Left: Contacts & Details */}
                      <div className="space-y-6">
                        {/* Contacts */}
                        <div>
                          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Key Contacts</h4>
                          <div className="space-y-3">
                            {trade.contacts.map((contact, i) => (
                              <div key={i} className="flex items-center justify-between p-3 bg-white rounded-md border border-gray-200 shadow-sm">
                                <div>
                                  <div className="font-medium text-gray-900">{contact.name}</div>
                                  <div className="text-xs text-gray-500">{contact.role}</div>
                                </div>
                                <div className="flex gap-2">
                                  {contact.phone && (
                                    <Button 
                                      variant={contact.preferred.includes('phone') ? 'default' : 'outline'} 
                                      size="sm" 
                                      className={cn("h-8 gap-1.5 text-xs", contact.preferred.includes('phone') ? "bg-blue-600 hover:bg-blue-700" : "")}
                                    >
                                      <Phone className="h-3.5 w-3.5" />
                                      {contact.phone}
                                    </Button>
                                  )}
                                  {contact.preferred.includes('text') && contact.phone && (
                                    <Button 
                                      variant="default" 
                                      size="sm" 
                                      className="h-8 gap-1.5 text-xs bg-green-600 hover:bg-green-700"
                                    >
                                      <MessageSquare className="h-3.5 w-3.5" />
                                      Text
                                    </Button>
                                  )}
                                  {contact.email && (
                                    <Button 
                                      variant={contact.preferred.includes('email') ? 'default' : 'outline'} 
                                      size="sm" 
                                      className={cn("h-8 gap-1.5 text-xs", contact.preferred.includes('email') ? "bg-blue-600 hover:bg-blue-700" : "")}
                                    >
                                      <Mail className="h-3.5 w-3.5" />
                                      Email
                                    </Button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Notes if any */}
                        {trade.notes && (
                          <div>
                            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                              <FileText className="h-3.5 w-3.5" /> Notes
                            </h4>
                            <p className="text-gray-700 text-sm bg-yellow-50/50 p-3 rounded border border-yellow-100">
                              {trade.notes}
                            </p>
                          </div>
                        )}
                      </div>

                      {/* Right: Company Info & Meta */}
                      <div className="space-y-5">
                        <div>
                          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Company Details</h4>
                          <div className="space-y-3">
                            <div className="flex items-center gap-3">
                              <div className="h-8 w-8 rounded bg-gray-100 flex items-center justify-center text-gray-500 shrink-0">
                                <Phone className="h-4 w-4" />
                              </div>
                              <div className="flex-1">
                                <div className="text-xs text-gray-500">Main Office</div>
                                <div className="text-gray-900 font-medium">{trade.phone}</div>
                              </div>
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-gray-400 hover:text-gray-900">
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                            
                            {trade.website && (
                              <div className="flex items-center gap-3">
                                <div className="h-8 w-8 rounded bg-gray-100 flex items-center justify-center text-gray-500 shrink-0">
                                  <Globe className="h-4 w-4" />
                                </div>
                                <div className="flex-1 overflow-hidden">
                                  <div className="text-xs text-gray-500">Website</div>
                                  <a href={`https://${trade.website}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline font-medium truncate block">
                                    {trade.website}
                                  </a>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="pt-4 border-t border-gray-200/60">
                          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5" /> Audit
                          </h4>
                          <div className="space-y-1.5 text-xs text-gray-500">
                            <div>Added by <span className="font-medium text-gray-700">{trade.addedBy}</span> on {trade.addedDate}</div>
                            {trade.editedBy && (
                              <div>Last edited by <span className="font-medium text-gray-700">{trade.editedBy}</span> on {trade.editedDate}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
