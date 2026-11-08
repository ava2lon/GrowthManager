import type {Metadata} from "next";
import "./globals.css";

export const metadata:Metadata={
  title:{default:"GrowthManager",template:"%s | GrowthManager"},
  description:"One workspace to plan, manage, and measure your growth.",
  applicationName:"GrowthManager",
  icons:{icon:[{url:"/icon.png",type:"image/png"}],apple:[{url:"/apple-icon.png",type:"image/png"}]}, openGraph:{images:[{url:"/growthmanager-logo.png",width:550,height:179,alt:"GrowthManager"}]},
};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en"><body className="min-h-screen antialiased">{children}</body></html>;
}
