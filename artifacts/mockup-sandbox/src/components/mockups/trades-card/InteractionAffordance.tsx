import React, { useState } from "react";
import { 
  Search, 
  Filter, 
  Plus, 
  Phone, 
  Mail, 
  Copy, 
  Edit, 
  Trash2, 
  ExternalLink,
  MessageSquare,
  Clock,
  MapPin,
  CheckCircle2
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardFooter } from "@/components/ui/card";

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
    leadTime: "2–3 weeks",
    phone: "(02) 9123 4567",
    website: "www.apexelectrical.com.au",
    contacts: [
      {
        name: "Dan Carter",
        role: "Estimator",
        phone: "0412 345 678",
        email: "dan@apexelectrical.com.au",
        preferred: "phone",
      }
    ],
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
    leadTime: "1 week",
    phone: "(02) 8888 9999",
    contacts: [
      {
        name: "Mei Lin",
        role: "Director",
        phone: "0499 888 777",
        email: "mei@bluelineplumbing.com.au",
        preferred: "email",
      }
    ],
    addedBy: "Sarah Jenkins",
    addedDate: "14 Oct 2023"
  },
  {
    id: "3",
    companyName: "Summit Carpentry",
    tradeType: "Carpentry",
    areasServed: ["All Sydney"],
    leadTime: "3–4 weeks",
    phone: "(02) 7777 6666",
    website: "summitcarpentry.com",
    contacts: [
      {
        name: "Chris Payne",
        role: "Owner",
        phone: "0455 444 333",
        email: "chris@summitcarpentry.com",
        preferred: "phone+email",
      }
    ],
    addedBy: "Mike Ross",
    addedDate: "20 Oct 2023"
  },
  {
    id: "4",
    companyName: "Ironclad Steel",
    tradeType: "Structural Steel",
    areasServed: ["City", "North Shore"],
    leadTime: "4–6 weeks",
    phone: "(02) 5555 4444",
    notes: "Cert III on file. Preferred for large beams.",
    contacts: [
      {
        name: "Tom Wells",
        role: "PM",
        phone: "0422 111 000",
        email: "tom.w@ironclad.com.au",
        preferred: "text",
      }
    ],
    addedBy: "Sarah Jenkins",
    addedDate: "01 Nov 2023"
  }
];

export function InteractionAffordance() {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 pb-12">
      {/* Sticky Filter Bar */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 shadow-sm px-6 py-4 flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="flex flex-col md:flex-row gap-4 w-full md:w-auto flex-1">
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <Input 
              placeholder="Search companies, contacts..." 
              className="pl-10 h-12 text-base border-slate-300 focus-visible:ring-blue-500 rounded-lg shadow-sm"
            />
          </div>
          <div className="flex gap-3 w-full md:w-auto">
            <select className="h-12 w-full md:w-48 border-slate-300 border shadow-sm rounded-lg px-3 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="all">All Trades</option>
              <option value="electrical">Electrical</option>
              <option value="plumbing">Plumbing</option>
              <option value="carpentry">Carpentry</option>
              <option value="steel">Structural Steel</option>
            </select>
            <select className="h-12 w-full md:w-48 border-slate-300 border shadow-sm rounded-lg px-3 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500">
              <option value="all">All Areas</option>
              <option value="cbd">CBD</option>
              <option value="north_shore">North Shore</option>
              <option value="inner_west">Inner West</option>
            </select>
          </div>
        </div>
        <Button className="w-full md:w-auto h-12 px-6 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg shadow-sm flex items-center gap-2 transition-colors">
          <Plus className="w-5 h-5" />
          Add Subcontractor
        </Button>
      </div>

      {/* Main Content */}
      <div className="p-6 max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {TRADES_DATA.map((trade) => (
            <Card 
              key={trade.id} 
              className="group flex flex-col bg-white border border-slate-200 shadow-sm hover:shadow-md hover:border-slate-300 transition-all duration-200 overflow-hidden"
            >
              <CardHeader className="p-5 pb-4 border-b border-slate-100 flex-none relative">
                <div className="absolute top-4 right-4 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-blue-600 hover:bg-blue-50">
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-red-600 hover:bg-red-50">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
                
                <div className="flex justify-between items-start mb-3 pr-20">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900 leading-tight mb-2">
                      {trade.companyName}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="bg-slate-100 text-slate-700 hover:bg-slate-200 font-medium">
                        {trade.tradeType}
                      </Badge>
                      <Badge variant="outline" className="text-amber-700 border-amber-200 bg-amber-50 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {trade.leadTime}
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-2 text-sm text-slate-600 mt-3">
                  <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                  <span>{trade.areasServed.join(", ")}</span>
                </div>
              </CardHeader>

              <CardContent className="p-0 flex-1 flex flex-col">
                {/* Company Details */}
                <div className="p-5 border-b border-slate-100 space-y-3 bg-slate-50/50">
                  <div className="flex items-center justify-between group/row">
                    <div className="flex items-center gap-2 text-sm text-slate-700">
                      <Phone className="w-4 h-4 text-slate-400" />
                      <span className="font-medium">{trade.phone}</span>
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      onClick={() => handleCopy(trade.phone, `${trade.id}-phone`)}
                      className="h-7 px-2 text-xs border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                    >
                      {copiedId === `${trade.id}-phone` ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                  {trade.website && (
                    <div className="flex items-center justify-between group/row">
                      <div className="flex items-center gap-2 text-sm text-slate-700">
                        <ExternalLink className="w-4 h-4 text-slate-400" />
                        <a href={`https://${trade.website}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                          {trade.website}
                        </a>
                      </div>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => handleCopy(trade.website!, `${trade.id}-web`)}
                        className="h-7 px-2 text-xs border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                      >
                        {copiedId === `${trade.id}-web` ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  )}
                  {trade.notes && (
                    <div className="mt-3 p-3 bg-amber-50/50 border border-amber-100 rounded-md text-sm text-slate-700 italic">
                      "{trade.notes}"
                    </div>
                  )}
                </div>

                {/* Contacts */}
                <div className="p-5 space-y-5 flex-1">
                  {trade.contacts.map((contact, idx) => (
                    <div key={idx} className="flex flex-col space-y-3">
                      <div className="flex justify-between items-end">
                        <div>
                          <div className="font-semibold text-slate-900">{contact.name}</div>
                          <div className="text-sm text-slate-500">{contact.role}</div>
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-2">
                        {contact.phone && (
                          <div className="flex w-full">
                            <Button 
                              title={contact.preferred.includes('phone') ? "Preferred Contact Method" : ""}
                              variant={contact.preferred.includes('phone') ? 'default' : 'outline'}
                              className={`flex-1 rounded-r-none border-r-0 ${
                                contact.preferred.includes('phone') 
                                  ? 'bg-blue-600 hover:bg-blue-700 text-white' 
                                  : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              <Phone className="w-4 h-4 mr-2" />
                              Call
                            </Button>
                            <Button 
                              variant={contact.preferred.includes('phone') ? 'default' : 'outline'}
                              size="icon"
                              onClick={() => handleCopy(contact.phone!, `${trade.id}-cphone-${idx}`)}
                              className={`rounded-l-none border-l border-white/20 px-2 ${
                                contact.preferred.includes('phone')
                                  ? 'bg-blue-700 hover:bg-blue-800 text-white'
                                  : 'border-slate-300 text-slate-500 hover:text-slate-900 hover:bg-slate-100 border-l-slate-200'
                              }`}
                            >
                              {copiedId === `${trade.id}-cphone-${idx}` ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                            </Button>
                          </div>
                        )}

                        {contact.email && (
                          <div className="flex w-full">
                            <Button 
                              title={contact.preferred.includes('email') ? "Preferred Contact Method" : ""}
                              variant={contact.preferred.includes('email') ? 'default' : 'outline'}
                              className={`flex-1 rounded-r-none border-r-0 ${
                                contact.preferred.includes('email') 
                                  ? 'bg-blue-600 hover:bg-blue-700 text-white' 
                                  : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              <Mail className="w-4 h-4 mr-2" />
                              Email
                            </Button>
                            <Button 
                              variant={contact.preferred.includes('email') ? 'default' : 'outline'}
                              size="icon"
                              onClick={() => handleCopy(contact.email!, `${trade.id}-cemail-${idx}`)}
                              className={`rounded-l-none border-l border-white/20 px-2 ${
                                contact.preferred.includes('email')
                                  ? 'bg-blue-700 hover:bg-blue-800 text-white'
                                  : 'border-slate-300 text-slate-500 hover:text-slate-900 hover:bg-slate-100 border-l-slate-200'
                              }`}
                            >
                              {copiedId === `${trade.id}-cemail-${idx}` ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                            </Button>
                          </div>
                        )}
                        
                        {contact.preferred === 'text' && (
                          <div className="flex w-full col-span-2">
                             <Button 
                                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                              >
                                <MessageSquare className="w-4 h-4 mr-2" />
                                Send Text Message
                              </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>

              <CardFooter className="px-5 py-3 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-400 flex justify-between items-center mt-auto">
                <div>Added by {trade.addedBy} · {trade.addedDate}</div>
                {trade.editedBy && <div>Edited by {trade.editedBy} · {trade.editedDate}</div>}
              </CardFooter>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
