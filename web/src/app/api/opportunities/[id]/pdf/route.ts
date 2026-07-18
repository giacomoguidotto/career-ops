import { careerOpsRoot } from "@/lib/career-ops";
import { lifecycleErrorResponse } from "@/lib/core/opportunity-lifecycle-api";
import { allowPdfOverflow } from "@/lib/core/opportunity-lifecycle";
import { recoverPdfWork } from "@/lib/core/work-recovery";
import { readDurableWorker, settleDurableWorker } from "@/lib/core/worker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opportunity = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(opportunity) || opportunity <= 0) {
    return Response.json({ error: { code: "invalid-opportunity", message: "Opportunity must be a positive tracker number." } }, { status: 400 });
  }
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: { code: "invalid-request", message: "A JSON command body is required." } }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input).sort().join("\0");
  if (
    ![
      ["action", "expectedRevision", "pages"].sort().join("\0"),
      ["action", "expectedRevision", "pages", "workerId"].sort().join("\0"),
    ].includes(keys)
    || input.action !== "allow-page-count"
    || typeof input.expectedRevision !== "string"
    || typeof input.pages !== "number"
    || (input.workerId !== undefined && (typeof input.workerId !== "string" || !/^job-[a-z0-9-]{1,96}$/i.test(input.workerId)))
  ) return Response.json({ error: { code: "invalid-request", message: "The PDF allowance command is invalid." } }, { status: 400 });
  try {
    const outcome = await allowPdfOverflow(careerOpsRoot(), {
      opportunity,
      expectedRevision: input.expectedRevision,
      pages: input.pages,
    });
    const effect = String(outcome.effect ?? "unavailable");
    let recovery = null;
    if (["changed", "unchanged"].includes(effect) && typeof input.workerId === "string") {
      const worker = readDurableWorker(careerOpsRoot(), input.workerId);
      if (worker?.workOrder.workflow === "pdf" && worker.workOrder.opportunity === opportunity) {
        recovery = await recoverPdfWork(careerOpsRoot(), worker.workOrder, { trigger: "reload" });
        settleDurableWorker(careerOpsRoot(), worker.id, recovery);
      }
    }
    return Response.json({ ...outcome, ...(recovery ? { recovery } : {}) }, { status: effect === "conflict" ? 409 : effect === "unavailable" ? 503 : effect === "blocked" ? 422 : 200 });
  } catch (error) {
    return lifecycleErrorResponse(error);
  }
}
