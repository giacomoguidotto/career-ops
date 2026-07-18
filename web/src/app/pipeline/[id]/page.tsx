import { notFound } from "next/navigation";
import { readOpportunityWorkspace } from "@/lib/career-ops";
import { OpportunityView } from "@/components/opportunity-view";

export const dynamic = "force-dynamic";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspace = await readOpportunityWorkspace(id);
  if (!workspace) notFound();
  return <OpportunityView workspace={workspace} />;
}
