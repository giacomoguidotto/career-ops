import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import { listOpportunityLifecycle } from "@/lib/core/opportunity-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(listOpportunityLifecycle(careerOpsRoot()));
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
