import fs from "node:fs";
import path from "node:path";
import { listDurableWorkers, type DurableWorker } from "./worker-store.ts";
import {
  GROUP_CHILD_OUTCOMES,
  type DurableWorkGroup,
  type DurableWorkGroupMember,
  type GroupChildOutcome,
  type ProjectedGroupChild,
  type ProjectedWorkGroup,
} from "./work-group.ts";
import type { WorkRecovery } from "./work-recovery.ts";

export { GROUP_CHILD_OUTCOMES } from "./work-group.ts";
export type { DurableWorkGroup, DurableWorkGroupMember, GroupChildOutcome, ProjectedGroupChild, ProjectedWorkGroup } from "./work-group.ts";

const GROUP_ID = /^group-[a-z0-9-]{1,96}$/i;
const WORKER_ID = /^job-[a-z0-9-]{1,96}$/i;
const STAGE = /^[a-z][a-z0-9_]*$/;
const REVISION = /^[a-f0-9]{64}$/;

function groupDir(root: string): string {
  return path.join(root, ".career-ops-web", "work-groups");
}

function groupPath(root: string, id: string): string {
  if (!GROUP_ID.test(id)) throw new Error("invalid work group id");
  return path.join(groupDir(root), `${id}.json`);
}

function validMember(value: unknown): value is DurableWorkGroupMember {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const member = value as DurableWorkGroupMember;
  return WORKER_ID.test(member.workerId)
    && Number.isSafeInteger(member.opportunity)
    && member.opportunity > 0
    && typeof member.title === "string"
    && (member.subtitle === null || typeof member.subtitle === "string")
    && STAGE.test(member.expectedStage)
    && REVISION.test(member.expectedRevision)
    && ["ready", "suppressed", "conflict"].includes(member.disposition)
    && typeof member.code === "string"
    && typeof member.message === "string";
}

function write(root: string, group: DurableWorkGroup): DurableWorkGroup {
  const target = groupPath(root, group.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(group, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return group;
}

export function createDurableWorkGroup(
  root: string,
  input: {
    id: string;
    title: string;
    page?: string;
    children: DurableWorkGroupMember[];
  },
): DurableWorkGroup {
  if (!GROUP_ID.test(input.id) || input.children.length === 0 || !input.children.every(validMember)) {
    throw new Error("invalid work group");
  }
  const workerIds = new Set(input.children.map((child) => child.workerId));
  const opportunities = new Set(input.children.map((child) => child.opportunity));
  if (workerIds.size !== input.children.length || opportunities.size !== input.children.length) {
    throw new Error("work group children must be unique");
  }
  return write(root, {
    version: 1,
    id: input.id,
    kind: "lifecycle-batch",
    title: input.title.slice(0, 160),
    page: input.page?.startsWith("/") ? input.page.slice(0, 240) : null,
    createdAt: new Date().toISOString(),
    children: input.children,
  });
}

export function readDurableWorkGroup(root: string, id: string): DurableWorkGroup | null {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(groupPath(root, id), "utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const group = value as DurableWorkGroup;
  if (
    group.version !== 1
    || group.id !== id
    || group.kind !== "lifecycle-batch"
    || typeof group.title !== "string"
    || (group.page !== null && typeof group.page !== "string")
    || typeof group.createdAt !== "string"
    || !Array.isArray(group.children)
    || group.children.length === 0
    || !group.children.every(validMember)
  ) return null;
  const workerIds = new Set(group.children.map((child) => child.workerId));
  const opportunities = new Set(group.children.map((child) => child.opportunity));
  return workerIds.size === group.children.length && opportunities.size === group.children.length ? group : null;
}

export function listDurableWorkGroups(root: string): DurableWorkGroup[] {
  let names: string[];
  try {
    names = fs.readdirSync(groupDir(root)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((name) => readDurableWorkGroup(root, name.slice(0, -5)))
    .filter((group): group is DurableWorkGroup => group !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function ownsGroupChild(root: string, groupId: string, workerId: string, opportunity: number): boolean {
  const group = readDurableWorkGroup(root, groupId);
  return Boolean(group?.children.some((child) => (
    child.workerId === workerId
    && child.opportunity === opportunity
    && child.disposition === "ready"
  )));
}

export function owningGroupForChild(root: string, workerId: string): DurableWorkGroup | null {
  return listDurableWorkGroups(root).find((group) => group.children.some((child) => child.workerId === workerId)) ?? null;
}

function groupOutcome(recovery: WorkRecovery): GroupChildOutcome {
  if (recovery.outcome === "changed") return "changed";
  if (recovery.outcome === "recovered") return "recovered";
  if (recovery.outcome === "paused") return "paused";
  if (recovery.outcome === "unchanged") return "unchanged";
  if (recovery.outcome === "conflict") return "conflict";
  return "failed";
}

function projectMember(member: DurableWorkGroupMember, worker: DurableWorker | null): ProjectedGroupChild {
  if (!worker) {
    const outcome = member.disposition === "ready" ? null : member.disposition;
    return {
      workerId: member.workerId,
      opportunity: member.opportunity,
      title: member.title,
      subtitle: member.subtitle,
      state: member.disposition === "ready" ? "queued" : member.disposition === "conflict" ? "attention" : "history",
      outcome,
      message: member.message,
      canonicalEvidence: {
        stage: member.expectedStage,
        revision: member.expectedRevision,
        action: null,
        workOrderId: null,
      },
      artifacts: [],
      diagnostic: { code: member.code, stage: member.expectedStage, revision: member.expectedRevision },
      nextAction: member.disposition === "ready" ? null : {
        kind: "review",
        label: "Review current Opportunity",
        href: `/pipeline/${member.opportunity}`,
      },
      completedButUnmerged: false,
    };
  }

  const recovery = worker.recoveryHistory.at(-1) ?? null;
  const completedButUnmerged = Boolean(
    recovery?.artifact
    && !["changed", "recovered", "unchanged"].includes(recovery.outcome),
  );
  const needsAttention = worker.status === "terminal"
    && (!worker.acknowledgedAt || completedButUnmerged);
  return {
    workerId: member.workerId,
    opportunity: member.opportunity,
    title: worker.title,
    subtitle: worker.subtitle,
    state: worker.status === "active" ? "active" : needsAttention ? "attention" : "history",
    outcome: recovery ? groupOutcome(recovery) : null,
    message: recovery?.message ?? worker.currentPhase.label,
    canonicalEvidence: {
      stage: recovery?.diagnostic.stage ?? worker.workOrder.source.stage,
      revision: recovery?.diagnostic.revision ?? worker.workOrder.source.revision,
      action: worker.workOrder.action,
      workOrderId: worker.workOrder.id,
    },
    artifacts: recovery?.diagnostic.artifacts ?? [],
    diagnostic: recovery?.diagnostic ?? {
      code: worker.currentPhase.code,
      stage: worker.workOrder.source.stage,
      revision: worker.workOrder.source.revision,
    },
    nextAction: recovery?.nextAction ?? null,
    completedButUnmerged,
  };
}

export function projectWorkGroup(root: string, group: DurableWorkGroup): ProjectedWorkGroup {
  const workers = new Map(
    listDurableWorkers(root)
      .filter((worker) => worker.batchId === group.id)
      .map((worker) => [worker.id, worker]),
  );
  const children = group.children.map((member) => projectMember(member, workers.get(member.workerId) ?? null));
  const summary = Object.fromEntries(GROUP_CHILD_OUTCOMES.map((outcome) => [outcome, 0])) as Record<GroupChildOutcome, number>;
  for (const child of children) if (child.outcome) summary[child.outcome] += 1;
  return {
    ...group,
    summary,
    activeChildren: children.filter((child) => ["queued", "active", "attention"].includes(child.state)),
    historyChildren: children.filter((child) => child.state === "history"),
    attentionCount: children.filter((child) => child.state === "attention").length,
  };
}

export function readProjectedWorkGroup(root: string, id: string): ProjectedWorkGroup | null {
  const group = readDurableWorkGroup(root, id);
  return group ? projectWorkGroup(root, group) : null;
}

export function listProjectedWorkGroups(root: string): ProjectedWorkGroup[] {
  return listDurableWorkGroups(root).map((group) => projectWorkGroup(root, group));
}
