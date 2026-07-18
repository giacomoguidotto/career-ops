import { careerOpsRoot } from "@/lib/career-ops";
import { isWorkerActive } from "@/lib/core/run-registry";
import { recoverLifecycleWork, type WorkRecoveryTrigger } from "@/lib/core/work-recovery";
import {
  acknowledgeDurableWorker,
  readDurableWorker,
  settleDurableWorker,
} from "@/lib/core/worker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RECOVERY_TRIGGERS = new Set<WorkRecoveryTrigger>([
  "completed",
  "timeout",
  "disconnect",
  "reload",
  "non-zero-exit",
  "paused",
  "uncertain-close",
]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const worker = readDurableWorker(careerOpsRoot(), id);
  if (!worker) return Response.json({ error: "worker not found" }, { status: 404 });
  return Response.json({ active: isWorkerActive(id), worker });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const root = careerOpsRoot();
  const worker = readDurableWorker(root, id);
  if (!worker) return Response.json({ error: "worker not found" }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (body.action === "acknowledge") {
    return Response.json({ worker: acknowledgeDurableWorker(root, id) });
  }
  if (body.action !== "recover" || !RECOVERY_TRIGGERS.has(body.trigger as WorkRecoveryTrigger)) {
    return Response.json({ error: "unsupported worker action" }, { status: 400 });
  }
  if (isWorkerActive(id)) {
    return Response.json({ active: true, worker }, { status: 202 });
  }
  const recovery = await recoverLifecycleWork(root, worker.workOrder, {
    trigger: body.trigger as WorkRecoveryTrigger,
  });
  return Response.json({ active: false, worker: settleDurableWorker(root, id, recovery), recovery });
}
