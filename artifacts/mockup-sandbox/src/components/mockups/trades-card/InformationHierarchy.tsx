import React, { useState } from "react";
import { 
  Search, 
  Plus, 
  MapPin, 
  Clock, 
  Phone, 
  Mail, 
  Copy, 
  Globe, 
  MessageSquare,
  MoreVertical,
  Edit2,
  Trash2,
  Building2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TRADES = [
  {
    id: 1,
    company: "Apex Electrical",
    trade: "Electrical",
    areas: "North Shore, CBD",
    color: "bg-amber-500",
    textColor: "text-amber-700",
    bgColor: "bg-amber-50",
    contacts: [
      {
        name: "Dan Carter",
        role: "Estimator",
        pref: "Phone",
        phone: "(02) 9123 4567",
        email: "dan@apexelectrical.example.com",
      }
    ],
    leadTime: "2–3 weeks",
    website: "apexelectrical.com",
    companyPhone: "(02) 9123 4567",
    notes: "",
    addedBy: "System",
    addedDate: "12 Oct 2023",
    editedBy: "Jane Smith",
    editedDate: "2 Nov 2023",
  },
  {
    id: 2,
    company: "BlueLine Plumbing",
    trade: "Plumbing",
    areas: "Inner West, CBD",
    color: "bg-blue-500",
    textColor: "text-blue-700",
    bgColor: "bg-blue-50",
    contacts: [
      {
        name: "Mei Lin",
        role: "Director",
        pref: "Email",
        phone: "(02) 9876 5432",
        email: "mei@blueline.example.com",
      }
    ],
    leadTime: "1 week",
    website: "bluelineplumbing.com",
    companyPhone: "(02) 9876 5432",
    notes: "",
    addedBy: "John Doe",
    addedDate: "5 Jan 2024",
    editedBy: "System",
    editedDate: "5 Jan 2024",
  },
  {
    id: 3,
    company: "Summit Carpentry",
    trade: "Carpentry",
    areas: "All Sydney",
    color: "bg-orange-600",
    textColor: "text-orange-700",
    bgColor: "bg-orange-50",
    contacts: [
      {
        name: "Chris Payne",
        role: "Owner",
        pref: "Phone + Email",
        phone: "0412 345 678",
        email: "chris@summitcarpentry.example.com",
      }
    ],
    leadTime: "3–4 weeks",
    website: "summitcarpentry.com",
    companyPhone: "0412 345 678",
    notes: "",
    addedBy: "Jane Smith",
    addedDate: "10 Feb 2024",
    editedBy: "",
    editedDate: "",
  },
  {
    id: 4,
    company: "Ironclad Steel",
    trade: "Structural Steel",
    areas: "City, North Shore",
    color: "bg-slate-700",
    textColor: "text-slate-700",
    bgColor: "bg-slate-100",
    contacts: [
      {
        name: "Tom Wells",
        role: "PM",
        pref: "Text",
        phone: "0498 765 432",
        email: "tom@ironclad.example.com",
      }
    ],
    leadTime: "Unknown",
    website: "ironcladsteel.com",
    companyPhone: "02 8888 9999",
    notes: 'Cert III on file. Preferred for large beams.',
    addedBy: "System",
    addedDate: "1 Mar 2024",
    editedBy: "",
    editedDate: "",
  }
];

export function InformationHierarchy() {
  const [searchTerm, setSearchTerm] = useState("");

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Sticky Filter Bar */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200 px-6 py-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-1">
          <div className="relative max-w-sm w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input 
              placeholder="Search companies, trades, or areas..." 
              className="pl-9 bg-slate-50 border-slate-200"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="h-8 w-px bg-slate-200 hidden sm:block"></div>
          <select className="h-10 px-3 py-2 rounded-md border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900">
            <option value="">All Trades</option>
            <option value="electrical">Electrical</option>
            <option value="plumbing">Plumbing</option>
            <option value="carpentry">Carpentry</option>
          </select>
        </div>
        <Button className="bg-slate-900 text-white hover:bg-slate-800 shrink-0">
          <Plus className="w-4 h-4 mr-2" />
          Add Subcontractor
        </Button>
      </header>

      {/* Main Content */}
      <main className="p-6 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {TRADES.map((trade) => (
            <Card key={trade.id} className="overflow-hidden border-slate-200 shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col">
              {/* Zone 1: Company Identity */}
              <div className="relative p-5 border-b border-slate-100 bg-white">
                <div className={`absolute top-0 left-0 w-1.5 h-full ${trade.color}`}></div>
                
                <div className="flex justify-between items-start mb-3">
                  <div className="pl-3">
                    <h2 className="text-xl font-bold text-slate-900 leading-tight mb-1">{trade.company}</h2>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className={`${trade.bgColor} ${trade.textColor} hover:${trade.bgColor} border-transparent font-medium`}>
                        {trade.trade}
                      </Badge>
                      <div className="flex items-center text-sm text-slate-500">
                        <MapPin className="w-3.5 h-3.5 mr-1" />
                        {trade.areas}
                      </div>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-slate-600 -mr-2 -mt-2">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem>
                        <Edit2 className="w-4 h-4 mr-2" /> Edit Trade
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-red-600 focus:text-red-600">
                        <Trash2 className="w-4 h-4 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                
                <div className="pl-3 flex items-center mt-4">
                  <Badge variant="outline" className="text-xs font-normal bg-slate-50 text-slate-700 border-slate-200 px-2 py-0.5 rounded-md flex items-center">
                    <Clock className="w-3.5 h-3.5 mr-1.5 text-slate-400" />
                    Lead time: <span className="font-semibold ml-1">{trade.leadTime}</span>
                  </Badge>
                </div>
              </div>

              {/* Zone 2: Contact People */}
              <div className="p-5 bg-slate-50/50 flex-1">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Primary Contacts</h3>
                <div className="space-y-4">
                  {trade.contacts.map((contact, idx) => (
                    <div key={idx} className="bg-white rounded-lg p-3 border border-slate-100 shadow-sm">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <div className="font-semibold text-slate-900">{contact.name}</div>
                          <div className="text-xs text-slate-500">{contact.role}</div>
                        </div>
                        <Badge variant="outline" className="text-[10px] uppercase bg-slate-50 text-slate-500 border-slate-200 py-0">
                          Pref: {contact.pref}
                        </Badge>
                      </div>
                      
                      <div className="flex gap-2 mt-3">
                        <div className="flex-1 flex items-center gap-1">
                          <Button variant="secondary" size="sm" className="h-8 w-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs px-2 justify-start">
                            {contact.pref.includes('Text') ? <MessageSquare className="w-3.5 h-3.5 mr-2 text-slate-500" /> : <Phone className="w-3.5 h-3.5 mr-2 text-slate-500" />}
                            <span className="truncate">{contact.phone}</span>
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-slate-400 hover:text-slate-600 hover:bg-slate-100">
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                        
                        <div className="flex-1 flex items-center gap-1">
                          <Button variant="secondary" size="sm" className="h-8 w-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs px-2 justify-start" disabled={!contact.email}>
                            <Mail className="w-3.5 h-3.5 mr-2 text-slate-500" />
                            <span className="truncate">{contact.email ? "Email" : "N/A"}</span>
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-slate-400 hover:text-slate-600 hover:bg-slate-100" disabled={!contact.email}>
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Zone 3: Details + Notes */}
              <div className="p-5 border-t border-slate-100 bg-white">
                <div className="grid grid-cols-2 gap-y-2 mb-4">
                  <div className="flex items-center text-sm text-slate-600">
                    <Building2 className="w-4 h-4 mr-2 text-slate-400" />
                    <span className="truncate">{trade.companyPhone}</span>
                    <button className="ml-1 text-slate-400 hover:text-slate-600"><Copy className="w-3 h-3" /></button>
                  </div>
                  <div className="flex items-center text-sm text-blue-600 hover:text-blue-800">
                    <Globe className="w-4 h-4 mr-2 text-slate-400" />
                    <a href={`https://${trade.website}`} target="_blank" rel="noreferrer" className="truncate hover:underline">
                      {trade.website}
                    </a>
                  </div>
                </div>

                {trade.notes && (
                  <div className="mb-4 bg-yellow-50/50 border border-yellow-100 rounded-md p-3 text-sm text-slate-700">
                    <span className="font-medium text-slate-900 block mb-1 text-xs">Notes</span>
                    {trade.notes}
                  </div>
                )}

                {/* Audit Row */}
                <div className="pt-3 mt-auto border-t border-slate-50 flex justify-between items-center text-[11px] text-slate-400">
                  <div>Added {trade.addedDate} by {trade.addedBy}</div>
                  {trade.editedDate && (
                    <div>Edited {trade.editedDate}</div>
                  )}
                </div>
              </div>

            </Card>
          ))}
        </div>
      </main>
    </div>
  );
}
