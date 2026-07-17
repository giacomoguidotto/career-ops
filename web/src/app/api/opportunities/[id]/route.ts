import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import { readOpportunityLifecycle } from "@/lib/core/opportunity-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    return Response.json(
      { error: { code: "invalid-opportunity", message: "Opportunity must be a positive tracker number." } },
      { status: 400 },
    );
  }
  try {
    return Response.json(readOpportunityLifecycle(careerOpsRoot(), Number(id)));
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
