import { careerOpsRoot } from "@/lib/career-ops";
import { LifecycleAdapterError, readOpportunityLifecycle } from "@/lib/core/opportunity-lifecycle";

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
    const failure = error instanceof LifecycleAdapterError
      ? error
      : new LifecycleAdapterError("lifecycle-read-failed", "The passive lifecycle read could not be completed.", 503);
    return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
  }
}

