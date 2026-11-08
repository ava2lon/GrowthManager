import type {Metadata} from "next";
import "./globals.css";

export const metadata:Metadata={
  title:{default:"GrowthManager",template:"%s | GrowthManager"},
  description:"One workspace to plan, manage, and measure your growth.",
  applicationName:"GrowthManager",
  icons:{icon:[{url:"/icon.svg",type:"image/svg+xml"}],apple:[{url:"/apple-icon.svg",type:"image/svg+xml"}]},
};

export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en"><body className="min-h-screen antialiased">{children}</body></html>;
}
