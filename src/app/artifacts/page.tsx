import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import ArtifactsApp from "@/components/artifacts/ArtifactsApp";

export const dynamic = "force-dynamic";

/** Authenticated, cross-conversation artifact workspace. */
export default async function ArtifactsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return <ArtifactsApp />;
}
