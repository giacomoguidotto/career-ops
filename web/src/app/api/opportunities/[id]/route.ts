import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import {
  readOpportunityLifecycle,
  requestOneGenerationLifecycle,
  setOpportunityPrimaryLifecycle,
} from "@/lib/core/opportunity-lifecycle";

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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opportunity = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(opportunity) || opportunity <= 0) {
    return Response.json(
      { error: { code: "invalid-opportunity", message: "Opportunity must be a positive tracker number." } },
      { status: 400 },
    );
  }
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: { code: "invalid-request", message: "A JSON command body is required." } }, { status: 400 });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Response.json({ error: { code: "invalid-request", message: "The lifecycle command is invalid." } }, { status: 400 });
  }
  const body = input as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (
    keys.join("\0") !== ["action", "expectedRevision", "expectedStage"].join("\0")
    || !["set-primary", "release-primary", "generate-once"].includes(String(body.action))
    || typeof body.expectedStage !== "string"
    || typeof body.expectedRevision !== "string"
  ) {
    return Response.json({ error: { code: "invalid-request", message: "The lifecycle command is invalid." } }, { status: 400 });
  }
  try {
    const outcome = body.action === "generate-once"
      ? await requestOneGenerationLifecycle(
          careerOpsRoot(), opportunity, body.expectedStage, body.expectedRevision,
        )
      : await setOpportunityPrimaryLifecycle(
          careerOpsRoot(),
          opportunity,
          body.expectedStage,
          body.expectedRevision,
          body.action === "release-primary" ? null : opportunity,
        );
    const status = outcome.effect === "conflict" ? 409 : outcome.effect === "unavailable" ? 503 : 200;
    return Response.json(outcome, { status });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
