import {useId, type SVGProps} from "react";

type BrandSymbolProps=SVGProps<SVGSVGElement>;

export function BrandSymbol({className,...props}:BrandSymbolProps){
  const gradientId=`growthmanager-gradient-${useId().replace(/:/g,"")}`;
  return <svg aria-hidden="true" viewBox="0 0 96 104" fill="none" className={className} {...props}>
    <defs><linearGradient id={gradientId} x1="18" y1="5" x2="72" y2="96" gradientUnits="userSpaceOnUse"><stop stopColor="#20A4FF"/><stop offset=".52" stopColor="#245BFF"/><stop offset="1" stopColor="#702BFF"/></linearGradient></defs>
    <path fill={`url(#${gradientId})`} d="M48 2 89 26 73 35 48 21 18 38V67L48 84 62 76V64L48 72 37 65 80 40V78L48 99 4 74V29L48 2Z"/>
    <path fill="#080D1D" d="M48 28 69 40 48 52 37 59 48 66 62 58 62 76 48 84 18 67V38L48 28Z" opacity="0"/>
    <path fill={`url(#${gradientId})`} d="m38 50 29-17 13 7-29 17-13-7Z"/>
  </svg>;
}

export function BrandMark(){
  return <div className="inline-flex items-center gap-3 text-current" aria-label="GrowthManager">
    <BrandSymbol className="size-10 shrink-0"/>
    <span className="flex flex-col leading-none">
      <span className="text-[17px] font-semibold tracking-[-0.045em]">GrowthManager</span>
      <span className="mt-1.5 text-[7px] font-medium tracking-[0.28em] text-current/60">DATA. INSIGHT. <span className="text-[#7860FF]">GROWTH.</span></span>
    </span>
  </div>;
}
