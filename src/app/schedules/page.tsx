import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import SchedulesApp from "@/components/schedules/SchedulesApp";

// Reads the session (cookies) and is per-user; never prerender.
export const dynamic = "force-dynamic";

/**
 * Scheduled tasks home. Lists the signed-in user's automations and lets them
 * create / edit / run them. Unauthenticated visitors are redirected to /login.
 */
export default async function SchedulesPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  return <SchedulesApp />;
}
