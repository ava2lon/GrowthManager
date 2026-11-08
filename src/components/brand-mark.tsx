import type {SVGProps} from "react";

type BrandSymbolProps=SVGProps<SVGSVGElement>;

export function BrandSymbol({className,...props}:BrandSymbolProps){
  return <svg aria-hidden="true" viewBox="0 0 96 104" fill="none" className={className} {...props}>
    <defs><linearGradient id="growthmanager-mark-gradient" x1="18" y1="8" x2="76" y2="94" gradientUnits="userSpaceOnUse"><stop stopColor="#20A4FF"/><stop offset=".48" stopColor="#245BFF"/><stop offset="1" stopColor="#702BFF"/></linearGradient></defs>
    <path fill="url(#growthmanager-mark-gradient)" d="M48 3 89 26.5V48L69 59.5V38L48 26 27 38.5v27L48 78l13-7.5V59l-13 7.5-10-5.8V49l10-5.8 30 17.3v23L48 101 7 77.5v-51L48 3Z"/>
  </svg>;
}

export function BrandMark(){
  return <div className="inline-flex items-center gap-2.5 text-current" aria-label="GrowthManager">
    <BrandSymbol className="size-10 shrink-0"/>
    <span className="text-[17px] font-bold tracking-tight">GrowthManager</span>
  </div>;
}
