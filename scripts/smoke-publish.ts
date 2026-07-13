/**
 * Runtime smoke test for the unified-Artifacts publish choke-point. Exercises
 * publishArtifact() end-to-end against the real local-Supabase Postgres, then
 * cleans up every row it created. Run: npx tsx --env-file=.env scripts/smoke-publish.ts
 */
import prisma from "@/lib/db";
import { publishArtifact, loadPublicSite } from "@/lib/sites";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ✓ " + msg);
}

async function main() {
  const stamp = Date.now();
  const email = `smoke-${stamp}@example.test`;
  const user = await prisma.user.create({ data: { email, name: "Smoke" } });
  const convo = await prisma.conversation.create({
    data: { userId: user.id, title: "Smoke chat", model: "gpt-4o-mini" },
  });
  const artifact = await prisma.artifact.create({
    data: { conversationId: convo.id, identifier: "smoke-page", type: "html", title: "Smoke Page" },
  });
  await prisma.artifactVersion.create({
    data: {
      artifactId: artifact.id,
      version: 1,
      content: "<!doctype html><h1>hello smoke</h1>",
    },
  });

  let siteId = "";
  try {
    console.log("1) publish (makePublic) —");
    const res = await publishArtifact(prisma, {
      userId: user.id,
      conversationId: convo.id,
      identifier: "smoke-page",
      makePublic: true,
    });
    assert(res.ok, "publishArtifact returned ok");
    if (!res.ok) return;
    siteId = res.siteId;
    assert(res.detail.status === "deployed", `status is deployed (got ${res.detail.status})`);
    assert(res.detail.visibility === "link", `visibility is link (got ${res.detail.visibility})`);
    assert(res.ref.deployed === true, "ref marked deployed");

    const linked = await prisma.artifact.findUnique({ where: { id: artifact.id } });
    assert(linked?.publishedSiteId === siteId, "artifact.publishedSiteId links the shadow Site");

    console.log("2) public serving —");
    const pub = await loadPublicSite(prisma, res.detail.slug);
    assert(pub != null, "loadPublicSite returns content for the live slug");
    assert(pub?.content.includes("hello smoke"), "served content matches the artifact");

    console.log("3) idempotent re-publish (edit then publish again) —");
    await prisma.artifactVersion.create({
      data: { artifactId: artifact.id, version: 2, content: "<!doctype html><h1>hello v2</h1>" },
    });
    const res2 = await publishArtifact(prisma, {
      userId: user.id,
      conversationId: convo.id,
      identifier: "smoke-page",
      makePublic: true,
    });
    assert(res2.ok, "re-publish ok");
    if (res2.ok) {
      assert(res2.siteId === siteId, "re-publish reuses the SAME shadow Site (no dupe)");
      const pub2 = await loadPublicSite(prisma, res2.detail.slug);
      assert(pub2?.content.includes("hello v2"), "same URL now serves the updated version");
    }

    console.log("4) makePublic:false saves a candidate without going public —");
    const other = await prisma.artifact.create({
      data: { conversationId: convo.id, identifier: "smoke-draft", type: "html", title: "Draft" },
    });
    await prisma.artifactVersion.create({
      data: { artifactId: other.id, version: 1, content: "<h1>draft</h1>" },
    });
    const res3 = await publishArtifact(prisma, {
      userId: user.id,
      conversationId: convo.id,
      identifier: "smoke-draft",
      makePublic: false,
    });
    assert(res3.ok, "candidate save ok");
    if (res3.ok) {
      assert(res3.detail.status !== "deployed", `not deployed (got ${res3.detail.status})`);
      const pubDraft = await loadPublicSite(prisma, res3.detail.slug);
      assert(pubDraft === null, "candidate is NOT publicly served (private + no live version)");
    }

    console.log("5) code artifacts are rejected —");
    const codeA = await prisma.artifact.create({
      data: { conversationId: convo.id, identifier: "smoke-code", type: "code", title: "Code" },
    });
    await prisma.artifactVersion.create({
      data: { artifactId: codeA.id, version: 1, content: "print(1)" },
    });
    const res4 = await publishArtifact(prisma, {
      userId: user.id,
      conversationId: convo.id,
      identifier: "smoke-code",
      makePublic: true,
    });
    assert(!res4.ok, "publishing a 'code' artifact is rejected");

    console.log("\nALL SMOKE CHECKS PASSED ✅");
  } finally {
    // Cleanup via the PRIMARY client only: deleting the user FK-cascades the
    // conversation -> artifacts -> versions AND the user-owned Site -> SiteVersion
    // rows. The shadow Sites created here have no backend, so there are no
    // sites_data rows to purge — this avoids the connection-limited sites_data pool
    // (its role caps connections, and the live dev server may hold them all).
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
    console.log("cleaned up test rows.");
  }
}

main().catch(async (e) => {
  console.error("SMOKE FAILED:", e);
  await prisma.$disconnect();
  process.exit(1);
});
