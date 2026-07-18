import { careerOpsRoot } from "@/lib/career-ops";
import { listProjectedWorkGroups } from "@/lib/core/work-group-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ groups: listProjectedWorkGroups(careerOpsRoot()).slice(0, 50) });
}
