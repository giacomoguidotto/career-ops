import { notFound } from "next/navigation";
import { WorkGroupView } from "@/components/jobs/work-group-view";
import { careerOpsRoot } from "@/lib/career-ops";
import { readProjectedWorkGroup } from "@/lib/core/work-group-store";

export const dynamic = "force-dynamic";

export default async function WorkGroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const group = readProjectedWorkGroup(careerOpsRoot(), id);
  if (!group) notFound();
  return <WorkGroupView group={group} />;
}
