import fs from "node:fs";
import path from "node:path";
import type { LifecycleWorkOrder } from "./opportunity-lifecycle.ts";
import { WORK_RECOVERY_OUTCOMES, type WorkRecovery } from "./work-recovery.ts";

export type WorkerPhase = { code: string; label: string; at: string };

export type DurableWorker = {
  version: 1;
  id: string;
  kind: "lifecycle";
  title: string;
  subtitle: string | null;
  page: string | null;
  batchId: string | null;
  status: "active" | "terminal";
  workOrder: LifecycleWorkOrder;
  currentPhase: WorkerPhase;
  phases: WorkerPhase[];
  recoveryHistory: WorkRecovery[];
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  acknowledgedAt: string | null;
};

const WORKER_ID = /^job-[a-z0-9-]{1,96}$/i;
const NEXT_ACTIONS = new Set(["open", "resume", "retry", "review", "repair"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPhase(value: unknown): value is WorkerPhase {
  const item = record(value);
  return Boolean(item && typeof item.code === "string" && typeof item.label === "string" && typeof item.at === "string");
}

function isWorkOrder(value: unknown): value is LifecycleWorkOrder {
  const item = record(value);
  const source = record(item?.source);
  const consequence = record(item?.consequence);
  const artifact = record(item?.artifact);
  return Boolean(
    item
    && Number.isSafeInteger(item.opportunity)
    && typeof item.action === "string"
    && source && typeof source.stage === "string" && typeof source.revision === "string"
    && consequence && typeof consequence.stage === "string"
    && artifact && typeof artifact.kind === "string" && typeof artifact.directory === "string",
  );
}

function isRecovery(value: unknown): value is WorkRecovery {
  const item = record(value);
  const next = record(item?.nextAction);
  const diagnostic = record(item?.diagnostic);
  return Boolean(
    item
    && WORK_RECOVERY_OUTCOMES.includes(item.outcome as WorkRecovery["outcome"])
    && typeof item.message === "string"
    && typeof item.occurredAt === "string"
    && next && NEXT_ACTIONS.has(next.kind as string) && typeof next.label === "string"
    && diagnostic && Array.isArray(diagnostic.artifacts),
  );
}

function workerDir(root: string): string {
  return path.join(root, ".career-ops-web", "workers");
}

function workerPath(root: string, id: string): string {
  if (!WORKER_ID.test(id)) throw new Error("invalid worker id");
  return path.join(workerDir(root), `${id}.json`);
}

function write(root: string, worker: DurableWorker): DurableWorker {
  const target = workerPath(root, worker.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(worker, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return worker;
}

function phase(code: string, label: string): WorkerPhase {
  return { code, label, at: new Date().toISOString() };
}

export function createDurableWorker(
  root: string,
  input: {
    id: string;
    title: string;
    subtitle?: string;
    page?: string;
    batchId?: string;
    workOrder: LifecycleWorkOrder;
  },
): DurableWorker {
  const initial = phase("reserved", "Canonical work reserved");
  return write(root, {
    version: 1,
    id: input.id,
    kind: "lifecycle",
    title: input.title.slice(0, 160),
    subtitle: input.subtitle?.slice(0, 240) ?? null,
    page: input.page?.startsWith("/") ? input.page.slice(0, 240) : null,
    batchId: input.batchId?.slice(0, 120) ?? null,
    status: "active",
    workOrder: input.workOrder,
    currentPhase: initial,
    phases: [initial],
    recoveryHistory: [],
    startedAt: initial.at,
    updatedAt: initial.at,
    endedAt: null,
    acknowledgedAt: null,
  });
}

export function readDurableWorker(root: string, id: string): DurableWorker | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(workerPath(root, id), "utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const worker = value as DurableWorker;
  if (
    worker.version !== 1
    || worker.id !== id
    || worker.kind !== "lifecycle"
    || !["active", "terminal"].includes(worker.status)
    || typeof worker.title !== "string"
    || !isWorkOrder(worker.workOrder)
    || !isPhase(worker.currentPhase)
    || !Array.isArray(worker.phases) || !worker.phases.every(isPhase)
    || !Array.isArray(worker.recoveryHistory) || !worker.recoveryHistory.every(isRecovery)
    || typeof worker.startedAt !== "string"
    || typeof worker.updatedAt !== "string"
  ) return null;
  return worker;
}

export function listDurableWorkers(root: string): DurableWorker[] {
  let names: string[];
  try {
    names = fs.readdirSync(workerDir(root)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => readDurableWorker(root, name.slice(0, -5)))
    .filter((worker): worker is DurableWorker => worker !== null)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function appendWorkerPhase(root: string, id: string, code: string, label: string): DurableWorker | null {
  const worker = readDurableWorker(root, id);
  if (!worker) return null;
  const next = phase(code, label.slice(0, 160));
  return write(root, {
    ...worker,
    status: "active",
    currentPhase: next,
    phases: [...worker.phases, next].slice(-200),
    updatedAt: next.at,
    endedAt: null,
    acknowledgedAt: null,
  });
}

export function settleDurableWorker(root: string, id: string, recovery: WorkRecovery): DurableWorker | null {
  const worker = readDurableWorker(root, id);
  if (!worker) return null;
  const terminal = phase(`terminal:${recovery.outcome}`, recovery.message);
  return write(root, {
    ...worker,
    status: "terminal",
    currentPhase: terminal,
    phases: [...worker.phases, terminal].slice(-200),
    recoveryHistory: [...worker.recoveryHistory, recovery].slice(-40),
    updatedAt: terminal.at,
    endedAt: terminal.at,
  });
}

export function acknowledgeDurableWorker(root: string, id: string): DurableWorker | null {
  const worker = readDurableWorker(root, id);
  if (!worker || worker.status !== "terminal") return worker;
  const acknowledgedAt = new Date().toISOString();
  return write(root, { ...worker, acknowledgedAt, updatedAt: acknowledgedAt });
}
