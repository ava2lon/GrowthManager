import {z} from "zod";
import {WEBSITE_EVENT_MAX_METADATA_BYTES,WEBSITE_EVENT_MAX_METADATA_DEPTH,WEBSITE_EVENT_MAX_METADATA_KEYS,WEBSITE_ID_PATTERN} from "./config";

export function normalizeWebsiteDomain(input:string):string {
  const trimmed=input.trim();
  if(!trimmed||trimmed.length>253)throw new Error("Enter a valid website domain.");
  let parsed:URL;
  try{parsed=new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)?trimmed:"https://"+trimmed);}catch{throw new Error("Enter a valid website domain.");}
  if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||parsed.port)throw new Error("Enter a valid website domain without credentials or a custom port.");
  const host=parsed.hostname.toLowerCase().replace(/\.$/,"").replace(/^www\./,"");
  const labels=host.split(".");
  if(!host||host.length>253||host==="localhost"||/^\d{1,3}(\.\d{1,3}){3}$/.test(host)||labels.length<2||labels.some(x=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)))throw new Error("Enter a public website hostname.");
  return host;
}
export const websiteCreateSchema=z.object({name:z.string().trim().min(1).max(120),domain:z.string().trim().min(3).max(2048),description:z.string().trim().max(2000).optional().nullable()}).strict();
export const websitePatchSchema=z.object({name:z.string().trim().min(1).max(120).optional(),domain:z.string().trim().min(3).max(2048).optional(),description:z.string().trim().max(2000).nullable().optional(),status:z.enum(["ACTIVE","PAUSED"]).optional(),trackingEnabled:z.boolean().optional()}).strict().refine(x=>Object.keys(x).length>0);
const metadataSchema=z.record(z.string().max(80),z.unknown()).refine(value=>{
  const serialized=JSON.stringify(value);
  if(Buffer.byteLength(serialized,"utf8")>WEBSITE_EVENT_MAX_METADATA_BYTES)return false;
  let keys=0;
  const visit=(item:unknown,depth:number):boolean=>{
    if(depth>WEBSITE_EVENT_MAX_METADATA_DEPTH)return false;
    if(item&&typeof item==="object"){
      if(Array.isArray(item))return item.length<=50&&item.every(child=>visit(child,depth+1));
      const entries=Object.entries(item as Record<string,unknown>);keys+=entries.length;
      return keys<=WEBSITE_EVENT_MAX_METADATA_KEYS&&entries.every(([key,child])=>!/(password|passwd|token|secret|authorization|cookie|card|cvv|ssn)/i.test(key)&&visit(child,depth+1));
    }
    return item===null||["string","number","boolean"].includes(typeof item);
  };
  return visit(value,0);
},"Event properties are too large, too deeply nested, or contain prohibited sensitive fields.");
export const trackingEventSchema=z.object({
  site_id:z.string().optional(),
  event:z.string().trim().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_.:-]*$/),
  anonymous_id:z.string().regex(/^anon_[A-Za-z0-9_-]{16,100}$/),
  session_id:z.string().regex(/^sess_[A-Za-z0-9_-]{16,100}$/),
  timestamp:z.string().datetime({offset:true}).optional(),
  page:z.object({url:z.string().url().max(2048).optional(),path:z.string().max(1024).optional(),title:z.string().max(300).optional()}).strict().optional(),
  referrer:z.string().max(2048).optional().nullable(),
  utm:z.object({source:z.string().max(200).optional().nullable(),medium:z.string().max(200).optional().nullable(),campaign:z.string().max(200).optional().nullable(),term:z.string().max(200).optional().nullable(),content:z.string().max(200).optional().nullable()}).strict().optional(),
  properties:metadataSchema.optional(),
  identity:z.object({email:z.string().email().max(320).optional(),external_id:z.string().trim().min(1).max(191).optional()}).strict().refine(x=>Boolean(x.email||x.external_id)).optional(),
}).strict();
export function validateMetadataDepth(value:unknown){const parsed=metadataSchema.safeParse(value??{});return parsed.success?parsed.data:null;}
export function isSafeTrackingId(value:string){return value.startsWith("site_")&&WEBSITE_ID_PATTERN.test(value.slice(5));}
