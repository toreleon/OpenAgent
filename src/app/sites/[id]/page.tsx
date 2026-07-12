import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SiteDetailShell } from "@/components/sites/SiteDetailShell";

export const dynamic = "force-dynamic";

/** Authenticated Site detail / review / deploy page. */
export default async function SiteDetailPage({ params }: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return <SiteDetailShell siteId={params.id} />;
}
