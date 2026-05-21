import React, { useState } from "react";
import { 
  Phone, 
  Mail, 
  MessageSquare, 
  Copy, 
  Star, 
  MoreVertical, 
  ChevronDown, 
  ChevronUp, 
  MapPin, 
  Clock, 
  Globe,
  Search,
  Filter
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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

const TRADE_COLORS: Record<string, string> = {
  "Electrical": "border-l-yellow-400 dark:border-l-yellow-500",
  "Plumbing": "border-l-blue-400 dark:border-l-blue-500",
  "Carpentry": "border-l-orange-400 dark:border-l-orange-500",
  "Structural Steel": "border-l-slate-400 dark:border-l-slate-500",
  "Concrete": "border-l-stone-400 dark:border-l-stone-500",
};

export function QuickDial() {
  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 p-4 md:p-8 font-sans text-neutral-900 dark:text-neutral-100">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header & Filters */}
        <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center bg-white dark:bg-neutral-800 p-4 rounded-xl shadow-sm border border-neutral-200 dark:border-neutral-700">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
            <Input placeholder="Search names, companies..." className="pl-9 bg-neutral-50 dark:bg-neutral-900 border-neutral-200 dark:border-neutral-700" />
          </div>
          <div className="flex gap-2 w-full md:w-auto">
            <Select>
              <SelectTrigger className="w-full md:w-40 bg-neutral-50 dark:bg-neutral-900">
                <SelectValue placeholder="All Trades" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Trades</SelectItem>
                <SelectItem value="elec">Electrical</SelectItem>
                <SelectItem value="plumb">Plumbing</SelectItem>
                <SelectItem value="carp">Carpentry</SelectItem>
              </SelectContent>
            </Select>
            <Select>
              <SelectTrigger className="w-full md:w-40 bg-neutral-50 dark:bg-neutral-900">
                <SelectValue placeholder="Any Area" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any Area</SelectItem>
                <SelectItem value="north">North Shore</SelectItem>
                <SelectItem value="cbd">CBD</SelectItem>
                <SelectItem value="west">Western Sydney</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Directory Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
          {TRADES.map((trade) => (
            <TradeCard key={trade.id} trade={trade} />
          ))}
        </div>

      </div>
    </div>
  );
}

function TradeCard({ trade }: { trade: Trade }) {
  const [isOpen, setIsOpen] = useState(false);
  const contact = trade.contacts[0]; // Assuming 1 primary contact per card for simplicity
  const borderColorClass = TRADE_COLORS[trade.tradeType] || "border-l-neutral-300";

  return (
    <Card className={`overflow-hidden border-l-4 ${borderColorClass} shadow-sm hover:shadow-md transition-shadow duration-200 bg-white dark:bg-neutral-800 border-y border-r border-y-neutral-200 border-r-neutral-200 dark:border-y-neutral-700 dark:border-r-neutral-700`}>
      <CardContent className="p-0">
        <div className="p-5 pb-4">
          
          {/* Top Row: Name and Menu */}
          <div className="flex justify-between items-start mb-1">
            <div>
              <h2 className="text-xl font-semibold tracking-tight leading-tight">{contact.name}</h2>
              <div className="flex items-center gap-2 mt-0.5 text-sm text-neutral-500 dark:text-neutral-400 font-medium">
                <span>{contact.role}</span>
                <span className="w-1 h-1 rounded-full bg-neutral-300 dark:bg-neutral-600"></span>
                <span className="text-neutral-700 dark:text-neutral-300">{trade.companyName}</span>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 -mt-1 -mr-2 text-neutral-400 hover:text-neutral-600">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>Edit Contact</DropdownMenuItem>
                <DropdownMenuItem>Update Company Info</DropdownMenuItem>
                <DropdownMenuItem className="text-red-600">Remove</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          
          {/* Action Buttons */}
          <div className="mt-5 space-y-2">
            
            {/* Phone Button */}
            {contact.phone && (
              <div className="flex gap-2">
                <Button 
                  className="flex-1 h-[52px] text-base justify-between px-4 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
                >
                  <div className="flex items-center gap-3">
                    {contact.preferred === 'text' ? <MessageSquare className="w-5 h-5 opacity-80" /> : <Phone className="w-5 h-5 opacity-80" />}
                    <span className="font-semibold tracking-wide">{contact.phone}</span>
                  </div>
                  {(contact.preferred === 'phone' || contact.preferred === 'phone+email' || contact.preferred === 'text') && (
                    <Badge variant="secondary" className="bg-emerald-700/50 hover:bg-emerald-700/50 text-emerald-50 border-none px-2 py-0 h-6 gap-1 flex items-center shadow-none">
                      <Star className="w-3 h-3 fill-current" /> Pref
                    </Badge>
                  )}
                </Button>
                <Button variant="outline" size="icon" className="h-[52px] w-[52px] shrink-0 border-neutral-200 dark:border-neutral-700 text-neutral-500">
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            )}

            {/* Email Button */}
            {contact.email && (
              <div className="flex gap-2">
                <Button 
                  variant="outline"
                  className="flex-1 h-11 justify-between px-4 border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900/50 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <Mail className="w-4 h-4 opacity-70 shrink-0" />
                    <span className="truncate">{contact.email}</span>
                  </div>
                  {(contact.preferred === 'email' || contact.preferred === 'phone+email') && (
                    <Badge variant="secondary" className="bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 border-none px-1.5 py-0 h-5 shrink-0 ml-2">
                      <Star className="w-3 h-3 fill-current mr-1" /> Pref
                    </Badge>
                  )}
                </Button>
                <Button variant="outline" size="icon" className="h-11 w-11 shrink-0 border-neutral-200 dark:border-neutral-700 text-neutral-400">
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Collapsible Company Info */}
        <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border-t border-neutral-100 dark:border-neutral-800">
          <CollapsibleTrigger asChild>
            <Button 
              variant="ghost" 
              className="w-full h-10 rounded-none text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 flex justify-center gap-1.5 bg-neutral-50/50 dark:bg-neutral-900/20"
            >
              {isOpen ? "Hide details" : "More company details"}
              {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="bg-neutral-50 dark:bg-neutral-900/50 px-5 py-4 text-sm text-neutral-600 dark:text-neutral-400 space-y-3 border-t border-neutral-100 dark:border-neutral-800">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-start gap-2.5">
                <MapPin className="w-4 h-4 text-neutral-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-neutral-700 dark:text-neutral-300">{trade.tradeType}</div>
                  <div className="text-neutral-500">{trade.areasServed.join(", ")}</div>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <Clock className="w-4 h-4 text-neutral-400 shrink-0" />
                <div>Lead time: <span className="font-medium text-neutral-700 dark:text-neutral-300">{trade.leadTime}</span></div>
              </div>
              <div className="flex items-center gap-2.5">
                <Phone className="w-4 h-4 text-neutral-400 shrink-0" />
                <div>Company: {trade.phone}</div>
              </div>
              {trade.website && (
                <div className="flex items-center gap-2.5">
                  <Globe className="w-4 h-4 text-neutral-400 shrink-0" />
                  <a href={`http://${trade.website}`} className="text-blue-600 dark:text-blue-400 hover:underline">{trade.website}</a>
                </div>
              )}
            </div>
            
            {trade.notes && (
              <div className="mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
                <div className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-1">Notes</div>
                <p className="text-neutral-600 dark:text-neutral-300">{trade.notes}</p>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
