import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import { listOpportunityLifecycle } from "@/lib/core/opportunity-lifecycle";
import { isGenerationEligible } from "@/lib/today-runway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Candidate = { opportunity: number; expectedStage: string; expectedRevision: string };

function isCandidate(value: unknown): value is Candidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.opportunity)
    && Number(candidate.opportunity) > 0
    && typeof candidate.expectedStage === "string"
    && /^[a-z][a-z0-9_]*$/.test(candidate.expectedStage)
    && typeof candidate.expectedRevision === "string"
    && /^[a-f0-9]{64}$/.test(candidate.expectedRevision);
}

export async function POST(request: Request) {
  let body: { candidates?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: "invalid-batch", message: "Batch review requires JSON." } }, { status: 400 });
  }
  if (!Array.isArray(body.candidates) || body.candidates.length > 100 || !body.candidates.every(isCandidate)) {
    return Response.json({ error: { code: "invalid-batch", message: "Batch candidates are invalid." } }, { status: 400 });
  }
  const unique = new Set(body.candidates.map((candidate) => candidate.opportunity));
  if (unique.size !== body.candidates.length) {
    return Response.json({ error: { code: "invalid-batch", message: "Batch candidates must be unique." } }, { status: 400 });
  }

  try {
    const fresh = await listOpportunityLifecycle(careerOpsRoot());
    const byNumber = new Map(fresh.opportunities.map((opportunity) => [opportunity.opportunity, opportunity]));
    const ready: Candidate[] = [];
    const skipped: Array<{ opportunity: number; code: string; message: string }> = [];

    for (const candidate of body.candidates) {
      const opportunity = byNumber.get(candidate.opportunity);
      if (!opportunity) {
        skipped.push({ opportunity: candidate.opportunity, code: "not-found", message: "Opportunity no longer exists." });
      } else if (opportunity.stage.id !== candidate.expectedStage || opportunity.revision !== candidate.expectedRevision) {
        skipped.push({ opportunity: candidate.opportunity, code: "changed", message: "Opportunity changed after review." });
      } else if (!isGenerationEligible(opportunity)) {
        skipped.push({ opportunity: candidate.opportunity, code: "excluded", message: "Opportunity is no longer eligible." });
      } else {
        ready.push({
          opportunity: opportunity.opportunity,
          expectedStage: opportunity.stage.id,
          expectedRevision: opportunity.revision,
        });
      }
    }

    return Response.json({
      code: ready.length > 0 ? "batch-ready" : "nothing-started",
      message: ready.length > 0 ? `${ready.length} eligible work item${ready.length === 1 ? "" : "s"} ready to start.` : "Nothing started.",
      ready,
      skipped,
      revision: fresh.revision,
    });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
