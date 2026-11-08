import Image from "next/image";

type BrandSymbolProps={
  className?:string;
  priority?:boolean;
};

export function BrandSymbol({className,priority=false}:BrandSymbolProps){
  return <Image
    src="/growthmanager-mark.png"
    alt=""
    width={512}
    height={512}
    className={className}
    priority={priority}
    aria-hidden="true"
  />;
}

export function BrandMark(){
  return <div className="inline-flex items-center gap-3 text-current" aria-label="GrowthManager">
    <BrandSymbol className="size-10 shrink-0" priority/>
    <span className="flex flex-col leading-none">
      <span className="text-[17px] font-semibold tracking-[-0.045em]">GrowthManager</span>
      <span className="mt-1.5 text-[7px] font-medium tracking-[0.28em] text-current/60">DATA. INSIGHT. <span className="text-[#7860FF]">GROWTH.</span></span>
    </span>
  </div>;
}
