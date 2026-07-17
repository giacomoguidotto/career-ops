import { careerOpsRoot } from "@/lib/career-ops";
import { LifecycleAdapterError, listOpportunityLifecycle } from "@/lib/core/opportunity-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(listOpportunityLifecycle(careerOpsRoot()));
  } catch (error) {
    const failure = error instanceof LifecycleAdapterError
      ? error
      : new LifecycleAdapterError("lifecycle-read-failed", "The passive lifecycle read could not be completed.", 503);
    return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
  }
}

