import {redirect} from "next/navigation";
import {auth} from "@/auth";
import {DashboardShell} from "@/components/dashboard-shell";
export default async function DashboardLayout({children}:{children:React.ReactNode}){const session=await auth();if(!session?.user?.id)redirect("/sign-in");return <DashboardShell user={session.user}>{children}</DashboardShell>;}
