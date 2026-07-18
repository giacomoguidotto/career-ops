import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import { readOpportunityLifecycle } from "@/lib/core/opportunity-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opportunity = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(opportunity) || opportunity <= 0) {
    return Response.json(
      { error: { code: "invalid-opportunity", message: "Opportunity must be a positive tracker number." } },
      { status: 400 },
    );
  }
  try {
    return Response.json(await readOpportunityLifecycle(careerOpsRoot(), opportunity));
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
