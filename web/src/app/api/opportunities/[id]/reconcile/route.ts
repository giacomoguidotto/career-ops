import { careerOpsRoot } from "@/lib/career-ops";
import { LifecycleAdapterError, requestOpportunityWork } from "@/lib/core/opportunity-lifecycle";
import { recoverLifecycleWork } from "@/lib/core/work-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opportunity = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(opportunity) || opportunity <= 0) {
    return Response.json({ error: "invalid Opportunity" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (
    Object.keys(body).sort().join("\0") !== ["expectedRevision", "expectedStage"].sort().join("\0")
    || typeof body.expectedStage !== "string"
    || typeof body.expectedRevision !== "string"
  ) {
    return Response.json({ error: "invalid reconciliation expectation" }, { status: 400 });
  }
  try {
    const reservation = await requestOpportunityWork(careerOpsRoot(), {
      opportunity,
      expectedStage: body.expectedStage,
      expectedRevision: body.expectedRevision,
    });
    if (!reservation.workOrder || !["work-requested", "already-running"].includes(reservation.code)) {
      return Response.json(reservation, { status: reservation.effect === "conflict" ? 409 : 422 });
    }
    const recovery = await recoverLifecycleWork(careerOpsRoot(), reservation.workOrder, { trigger: "reload" });
    const status = recovery.outcome === "conflict" ? 409 : recovery.outcome === "unavailable" ? 503 : 200;
    return Response.json({ recovery }, { status });
  } catch (error) {
    const code = error instanceof LifecycleAdapterError ? error.code : "reconciliation-unavailable";
    return Response.json({ error: code }, { status: error instanceof LifecycleAdapterError ? error.status : 503 });
  }
}
