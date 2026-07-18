import { careerOpsRoot } from "@/lib/career-ops";
import { listProjectedWorkGroups } from "@/lib/core/work-group-store";
import { listDurableWorkers } from "@/lib/core/worker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const root = careerOpsRoot();
  return Response.json({
    workers: listDurableWorkers(root).slice(0, 100),
    groups: listProjectedWorkGroups(root).slice(0, 50),
  });
}
