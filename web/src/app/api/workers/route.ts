import { careerOpsRoot } from "@/lib/career-ops";
import { listDurableWorkers } from "@/lib/core/worker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ workers: listDurableWorkers(careerOpsRoot()).slice(0, 100) });
}
