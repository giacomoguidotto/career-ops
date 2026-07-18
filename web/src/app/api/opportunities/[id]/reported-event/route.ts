import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import {
  readOpportunityLifecycle,
  recordOpportunityAttemptLifecycle,
  reportOpportunitySuccessorLifecycle,
} from "@/lib/core/opportunity-lifecycle";
import {
  interpretReportedEvent,
  ReportedEventError,
  type ReportRouteContext,
  type ReportedEventProposal,
} from "@/lib/core/reported-event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRoute(value: unknown): value is ReportRouteContext | null {
  if (value === null) return true;
  return record(value)
    && Object.keys(value).sort().join("\0") === ["channel", "destination", "follows", "id", "label", "type"].sort().join("\0")
    && ["outreach", "application", "qualifying", "followup"].includes(String(value.type))
    && ["id", "label", "destination", "channel"].every((key) => typeof value[key] === "string" && String(value[key]).length <= 1_000)
    && (value.follows === null || typeof value.follows === "string");
}

function validOccurredAt(value: unknown) {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function validProposal(value: Record<string, unknown>): value is ReportedEventProposal {
  if (value.kind === "attempt") {
    const keys = ["channel", "followUpTo", "kind", "notes", "occurredAt", "recipient", "result", "type"];
    return Object.keys(value).sort().join("\0") === keys.sort().join("\0")
      && validOccurredAt(value.occurredAt)
      && ["channel", "recipient", "result", "type"].every((key) => typeof value[key] === "string" && String(value[key]).trim().length > 0)
      && typeof value.notes === "string"
      && (value.followUpTo === null || typeof value.followUpTo === "string");
  }
  if (value.kind === "successor") {
    const keys = ["kind", "occurredAt", "result", "successor"];
    return Object.keys(value).sort().join("\0") === keys.sort().join("\0")
      && validOccurredAt(value.occurredAt)
      && typeof value.successor === "string"
      && typeof value.result === "string"
      && value.result.trim().length > 0;
  }
  return false;
}

function conflict(fresh: Awaited<ReturnType<typeof readOpportunityLifecycle>>) {
  return Response.json({
    code: "opportunity-conflict",
    effect: "conflict",
    retryable: false,
    message: "The Opportunity changed. Review the fresh context before interpreting or confirming.",
    before: fresh.opportunity,
    after: fresh.opportunity,
    artifacts: fresh.opportunity.artifacts,
    workOrder: null,
    consequences: null,
    attempts: fresh.attempts,
  }, { status: 409 });
}

function statusFor(effect: string) {
  return effect === "conflict" ? 409 : effect === "unavailable" ? 503 : effect === "blocked" ? 422 : 200;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opportunity = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(opportunity) || opportunity <= 0) {
    return Response.json({ error: { code: "invalid-opportunity", message: "Opportunity must be a positive tracker number." } }, { status: 400 });
  }
  let input: unknown;
  try { input = await request.json(); }
  catch { return Response.json({ error: { code: "invalid-request", message: "A JSON command body is required." } }, { status: 400 }); }
  if (!record(input) || typeof input.action !== "string" || typeof input.expectedStage !== "string" || typeof input.expectedRevision !== "string") {
    return Response.json({ error: { code: "invalid-request", message: "The reported-event command is invalid." } }, { status: 400 });
  }

  const root = careerOpsRoot();
  try {
    const fresh = await readOpportunityLifecycle(root, opportunity);
    if (fresh.opportunity.stage.id !== input.expectedStage || fresh.opportunity.revision !== input.expectedRevision) {
      return conflict(fresh);
    }

    if (input.action === "interpret") {
      const expectedKeys = ["action", "cliId", "expectedRevision", "expectedStage", "localDate", "report", "route"].sort().join("\0");
      if (
        Object.keys(input).sort().join("\0") !== expectedKeys
        || typeof input.cliId !== "string"
        || typeof input.localDate !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(input.localDate)
        || !validOccurredAt(input.localDate)
        || typeof input.report !== "string"
        || !validRoute(input.route)
      ) {
        return Response.json({ error: { code: "invalid-request", message: "The interpretation request is invalid." } }, { status: 400 });
      }
      const interpretation = await interpretReportedEvent({
        root,
        cliId: input.cliId,
        report: input.report,
        today: input.localDate,
        route: input.route,
        detail: fresh,
      });
      return Response.json({ interpretation, opportunity: fresh.opportunity, attempts: fresh.attempts });
    }

    if (input.action === "confirm") {
      const expectedKeys = ["action", "expectedRevision", "expectedStage", "proposal"].sort().join("\0");
      if (Object.keys(input).sort().join("\0") !== expectedKeys || !record(input.proposal) || !validProposal(input.proposal)) {
        return Response.json({ error: { code: "invalid-request", message: "The confirmation request is invalid." } }, { status: 400 });
      }
      const proposal = input.proposal as ReportedEventProposal;
      const outcome = proposal.kind === "attempt"
        ? await recordOpportunityAttemptLifecycle(
          root,
          opportunity,
          input.expectedStage,
          input.expectedRevision,
          (({ kind: _kind, ...attempt }) => attempt)(proposal),
        )
        : proposal.kind === "successor" && typeof proposal.successor === "string"
          ? await reportOpportunitySuccessorLifecycle(
            root,
            opportunity,
            input.expectedStage,
            input.expectedRevision,
            proposal.successor,
          )
          : null;
      if (!outcome) {
        return Response.json({ error: { code: "invalid-request", message: "The typed proposal is invalid." } }, { status: 400 });
      }
      const refreshed = await readOpportunityLifecycle(root, opportunity);
      return Response.json({ ...outcome, attempts: refreshed.attempts }, { status: statusFor(outcome.effect) });
    }
    return Response.json({ error: { code: "invalid-request", message: "The reported-event action is invalid." } }, { status: 400 });
  } catch (error) {
    if (error instanceof ReportedEventError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    return lifecycleErrorResponse(error);
  }
}
