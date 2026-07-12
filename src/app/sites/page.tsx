import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import SitesApp from "@/components/sites/SitesApp";

export const dynamic = "force-dynamic";

/** Authenticated Sites workspace (the "Sites list"). Self-gates; the public
 *  published pages live at /s/<slug> and bypass auth. */
export default async function SitesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return <SitesApp />;
}
