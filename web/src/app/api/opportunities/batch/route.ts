import { randomUUID } from "node:crypto";
import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import { listOpportunityLifecycle } from "@/lib/core/opportunity-lifecycle";
import { createDurableWorkGroup } from "@/lib/core/work-group-store";
import type { DurableWorkGroupMember } from "@/lib/core/work-group";
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
  let body: { candidates?: unknown; reviewed?: unknown };
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
  const reviewed = body.reviewed === undefined ? [] : body.reviewed;
  if (!Array.isArray(reviewed) || reviewed.length > 100 || !reviewed.every(isCandidate)) {
    return Response.json({ error: { code: "invalid-batch", message: "Reviewed exclusions are invalid." } }, { status: 400 });
  }
  const reviewedUnique = new Set(reviewed.map((candidate) => candidate.opportunity));
  if (reviewedUnique.size !== reviewed.length || reviewed.some((candidate) => unique.has(candidate.opportunity))) {
    return Response.json({ error: { code: "invalid-batch", message: "Reviewed Opportunities must be unique." } }, { status: 400 });
  }

  try {
    const fresh = await listOpportunityLifecycle(careerOpsRoot());
    const byNumber = new Map(fresh.opportunities.map((opportunity) => [opportunity.opportunity, opportunity]));
    const groupId = `group-today-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const childId = (index: number) => `job-${groupId.slice("group-".length)}-${index + 1}`;
    const ready: Array<Candidate & { workerId: string }> = [];
    const skipped: Array<{ opportunity: number; code: string; message: string }> = [];
    const children: DurableWorkGroupMember[] = [];

    for (const [index, candidate] of body.candidates.entries()) {
      const opportunity = byNumber.get(candidate.opportunity);
      const workerId = childId(index);
      if (!opportunity) {
        skipped.push({ opportunity: candidate.opportunity, code: "not-found", message: "Opportunity no longer exists." });
        children.push({
          workerId,
          opportunity: candidate.opportunity,
          title: `Opportunity #${candidate.opportunity}`,
          subtitle: null,
          expectedStage: candidate.expectedStage,
          expectedRevision: candidate.expectedRevision,
          disposition: "conflict",
          code: "not-found",
          message: "Opportunity no longer exists.",
        });
      } else if (opportunity.stage.id !== candidate.expectedStage || opportunity.revision !== candidate.expectedRevision) {
        skipped.push({ opportunity: candidate.opportunity, code: "changed", message: "Opportunity changed after review." });
        children.push({
          workerId,
          opportunity: opportunity.opportunity,
          title: opportunity.company,
          subtitle: opportunity.role,
          expectedStage: opportunity.stage.id ?? candidate.expectedStage,
          expectedRevision: opportunity.revision,
          disposition: "conflict",
          code: "changed",
          message: "Opportunity changed after review.",
        });
      } else if (!isGenerationEligible(opportunity)) {
        skipped.push({ opportunity: candidate.opportunity, code: "excluded", message: "Opportunity is no longer eligible." });
        children.push({
          workerId,
          opportunity: opportunity.opportunity,
          title: opportunity.company,
          subtitle: opportunity.role,
          expectedStage: opportunity.stage.id,
          expectedRevision: opportunity.revision,
          disposition: "suppressed",
          code: opportunity.candidacy.state,
          message: "Opportunity is no longer eligible.",
        });
      } else {
        ready.push({
          opportunity: opportunity.opportunity,
          expectedStage: opportunity.stage.id,
          expectedRevision: opportunity.revision,
          workerId,
        });
        children.push({
          workerId,
          opportunity: opportunity.opportunity,
          title: opportunity.company,
          subtitle: opportunity.role,
          expectedStage: opportunity.stage.id,
          expectedRevision: opportunity.revision,
          disposition: "ready",
          code: "ready",
          message: "Canonical work is ready to start.",
        });
      }
    }

    for (const [offset, candidate] of reviewed.entries()) {
      const opportunity = byNumber.get(candidate.opportunity);
      const workerId = childId(body.candidates.length + offset);
      const changed = !opportunity
        || opportunity.stage.id !== candidate.expectedStage
        || opportunity.revision !== candidate.expectedRevision;
      children.push({
        workerId,
        opportunity: candidate.opportunity,
        title: opportunity?.company ?? `Opportunity #${candidate.opportunity}`,
        subtitle: opportunity?.role ?? null,
        expectedStage: opportunity?.stage.id ?? candidate.expectedStage,
        expectedRevision: opportunity?.revision ?? candidate.expectedRevision,
        disposition: changed ? "conflict" : "suppressed",
        code: changed ? "changed" : opportunity?.candidacy.state ?? "excluded",
        message: changed
          ? "Opportunity changed after review."
          : "Canonical preflight kept this Opportunity out of the batch.",
      });
    }

    if (ready.length > 0) {
      createDurableWorkGroup(careerOpsRoot(), {
        id: groupId,
        title: `Today batch · ${ready.length} started`,
        page: "/",
        children,
      });
    }

    return Response.json({
      code: ready.length > 0 ? "batch-ready" : "nothing-started",
      message: ready.length > 0 ? `${ready.length} eligible work item${ready.length === 1 ? "" : "s"} ready to start.` : "Nothing started.",
      ready,
      skipped,
      groupId: ready.length > 0 ? groupId : null,
      revision: fresh.revision,
    });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
