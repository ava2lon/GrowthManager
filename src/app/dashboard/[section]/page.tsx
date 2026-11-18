import {notFound,redirect} from "next/navigation";

export default async function ModuleRoute({params}:{params:Promise<{section:string}>}) {
  const {section} = await params;
  if (section === "calendar") redirect("/dashboard/social");
  notFound();
}
