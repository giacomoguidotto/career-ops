import { careerOpsRoot } from "@/lib/career-ops";
import { readProjectedWorkGroup } from "@/lib/core/work-group-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const group = readProjectedWorkGroup(careerOpsRoot(), id);
  if (!group) return Response.json({ error: "work group not found" }, { status: 404 });
  return Response.json({ group });
}
