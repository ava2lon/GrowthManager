import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {webcrypto} from "node:crypto";
import {describe,it,expect,vi} from "vitest";

const trackerSource=readFileSync(new URL("../../../public/tracker.js",import.meta.url),"utf8");
function boot(options:{siteId?:string;fetchImpl?:typeof fetch;storage?:Map<string,string>;cryptoEnabled?:boolean}={}){
 const store=options.storage??new Map<string,string>(),calls:Array<{url:string;body:string}>=[];
 const fetchImpl=options.fetchImpl??(async(input:RequestInfo|URL,init?:RequestInit)=>{
  calls.push({url:String(input),body:String(init?.body??"")});
  return {ok:true,json:async()=>({session_id:"sess_server_rotated_1234567890123456"})} as Response;
 });
 const windowObject={addEventListener:vi.fn()};
 const documentObject={currentScript:{src:"https://app.growthmanager.test/tracker.js",getAttribute:()=>options.siteId??"site_12345678901234567890123456789012"},title:"Pricing",visibilityState:"visible",addEventListener:vi.fn()};
 const localStorageObject={getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value)};
 const sandbox:Record<string,unknown>={
  window:windowObject,document:documentObject,
  location:{href:"https://customer.example/pricing?utm_source=search",pathname:"/pricing",search:"?utm_source=search"},
  history:{pushState:vi.fn(),replaceState:vi.fn()},
  navigator:{},localStorage:localStorageObject,
  URL,URLSearchParams,Date,Uint8Array,Promise,Math,queueMicrotask,
  fetch:fetchImpl,crypto:options.cryptoEnabled===false?undefined:webcrypto,
 };
 runInNewContext(trackerSource,sandbox);
 return {window:windowObject as unknown as {GrowthManager?:{track:(name:string,props?:Record<string,unknown>)=>Promise<void>|undefined;identify:(identity:Record<string,string>)=>Promise<void>|undefined}},calls,store};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

describe("browser tracker",()=>{
 it("initializes, persists anonymous and session IDs, and emits a page view",async()=>{
  const tracker=boot();await flush();
  expect(tracker.window.GrowthManager).toBeDefined();
  expect(tracker.calls).toHaveLength(1);
  const payload=JSON.parse(tracker.calls[0].body);
  expect(payload.event).toBe("page_view");
  expect(payload.site_id).toMatch(/^site_/);
  expect(payload.anonymous_id).toMatch(/^anon_/);
  expect(payload.session_id).toMatch(/^sess_/);
  expect(tracker.store.has("gm:"+payload.site_id+":visitor")).toBe(true);
 });
 it("reuses an existing anonymous visitor and active session",async()=>{
  const site="site_12345678901234567890123456789012",store=new Map<string,string>([
   ["gm:"+site+":visitor","anon_existing_1234567890123456"],
   ["gm:"+site+":session","sess_existing_1234567890123456"],
   ["gm:"+site+":activity",String(Date.now())],
  ]);
  const tracker=boot({storage:store});await flush();
  const payload=JSON.parse(tracker.calls[0].body);
  expect(payload.anonymous_id).toBe("anon_existing_1234567890123456");
  expect(payload.session_id).toBe("sess_existing_1234567890123456");
 });
 it("emits custom events and explicit identity without reading form data",async()=>{
  const tracker=boot();await flush();
  await tracker.window.GrowthManager!.track("pricing_cta_clicked",{button_id:"pricing-cta"});
  await tracker.window.GrowthManager!.identify({email:"person@example.test",external_id:"cust-123"});
  expect(JSON.parse(tracker.calls[1].body).event).toBe("pricing_cta_clicked");
  expect(JSON.parse(tracker.calls[2].body).identity).toEqual({email:"person@example.test",external_id:"cust-123"});
 });
 it("fails silently on network errors and invalid configuration",async()=>{
  const failed=boot({fetchImpl:vi.fn().mockRejectedValue(new Error("network unavailable")) as unknown as typeof fetch});
  await flush();expect(failed.window.GrowthManager).toBeDefined();
  const invalid=boot({siteId:""});expect(invalid.window.GrowthManager).toBeUndefined();expect(invalid.calls).toHaveLength(0);
 });
 it("does not generate predictable IDs when Web Crypto is unavailable",()=>{
  const tracker=boot({cryptoEnabled:false});expect(tracker.window.GrowthManager).toBeUndefined();expect(tracker.calls).toHaveLength(0);
 });
});
