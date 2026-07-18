import type { WorkRecovery } from "./work-recovery.ts";

export const GROUP_CHILD_OUTCOMES = [
  "changed",
  "recovered",
  "failed",
  "paused",
  "unchanged",
  "suppressed",
  "conflict",
] as const;

export type GroupChildOutcome = (typeof GROUP_CHILD_OUTCOMES)[number];
export type GroupMemberDisposition = "ready" | "suppressed" | "conflict";

export type DurableWorkGroupMember = {
  workerId: string;
  opportunity: number;
  title: string;
  subtitle: string | null;
  expectedStage: string;
  expectedRevision: string;
  disposition: GroupMemberDisposition;
  code: string;
  message: string;
};

export type DurableWorkGroup = {
  version: 1;
  id: string;
  kind: "lifecycle-batch";
  title: string;
  page: string | null;
  createdAt: string;
  children: DurableWorkGroupMember[];
};

export type ProjectedGroupChild = {
  workerId: string;
  opportunity: number;
  title: string;
  subtitle: string | null;
  state: "queued" | "active" | "attention" | "history";
  outcome: GroupChildOutcome | null;
  message: string;
  canonicalEvidence: {
    stage: string;
    revision: string;
    action: string | null;
    workOrderId: string | null;
  };
  artifacts: WorkRecovery["diagnostic"]["artifacts"];
  diagnostic: WorkRecovery["diagnostic"] | {
    code: string;
    stage: string;
    revision: string;
  };
  nextAction: WorkRecovery["nextAction"] | null;
  completedButUnmerged: boolean;
};

export type ProjectedWorkGroup = DurableWorkGroup & {
  summary: Record<GroupChildOutcome, number>;
  activeChildren: ProjectedGroupChild[];
  historyChildren: ProjectedGroupChild[];
  attentionCount: number;
};

export function isWorkGroupId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^group-[a-z0-9-]{1,96}$/i.test(value);
}
