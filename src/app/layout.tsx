import type {Metadata} from "next";
import "./globals.css";
export const metadata:Metadata={title:{default:"GrowthManager",template:"%s | GrowthManager"},description:"One workspace to plan, manage, and measure your growth."};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body className="min-h-screen antialiased">{children}</body></html>;}
