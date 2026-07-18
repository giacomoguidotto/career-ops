import type { OpportunitySummary } from "@/lib/core/opportunity-lifecycle";

export type TodayQueueItem = {
  opportunity: OpportunitySummary;
  eligible: boolean;
  artifactLabel: string;
  actionLabel: string;
  attentionLabel: string;
  exclusion: "research-required" | "suppressed" | "agent-blocked" | "user-owned" | "external-owned" | null;
};

export type TodayRunway = {
  leading: TodayQueueItem | null;
  queue: TodayQueueItem[];
  eligible: TodayQueueItem[];
  researchRequired: TodayQueueItem[];
  suppressed: TodayQueueItem[];
  agentBlocked: TodayQueueItem[];
  userOwned: TodayQueueItem[];
  externalOwned: TodayQueueItem[];
};

const ATTENTION_PRIORITY: Record<OpportunitySummary["attemptAttention"]["state"], number> = {
  urgent: 0,
  review_due: 1,
  cold: 2,
  waiting: 5,
  unknown: 6,
  none: 6,
};

function words(value: string | null): string {
  if (!value) return "Open Opportunity";
  return value
    .replace(/^generate_/, "")
    .replace(/^execute_/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function artifactLabel(opportunity: OpportunitySummary): string {
  const artifact = opportunity.artifacts.find((item) => item.expectedAction === opportunity.stage.suggests);
  return words(artifact?.kind ?? opportunity.stage.suggests).toLowerCase();
}

export function actionLabel(opportunity: OpportunitySummary): string {
  if (opportunity.attemptAttention.state === "urgent") return "Review urgent attention";
  if (opportunity.attemptAttention.state === "review_due") return "Review due follow-up";
  if (opportunity.attemptAttention.state === "cold") return "Review cold follow-up";
  return words(opportunity.stage.suggests);
}

export function attentionLabel(opportunity: OpportunitySummary): string {
  const next = opportunity.attemptAttention.nextReview;
  switch (opportunity.attemptAttention.state) {
    case "urgent": return next ? `Urgent since ${next}` : "Urgent";
    case "review_due": return next ? `Review due ${next}` : "Review due";
    case "cold": return next ? `Cold since ${next}` : "Cold";
    case "waiting": return next ? `Waiting until ${next}` : "Waiting";
    case "unknown": return "Attention unknown";
    default: return "No dated attention";
  }
}

export function isGenerationEligible(opportunity: OpportunitySummary): boolean {
  return opportunity.stage.owner === "agent"
    && opportunity.primaryAction.kind === "generate"
    && opportunity.primaryAction.enabled
    && opportunity.capabilities.generate
    && !["research-required", "suppressed"].includes(opportunity.candidacy.state);
}

function exclusionFor(opportunity: OpportunitySummary, eligible: boolean): TodayQueueItem["exclusion"] {
  if (eligible) return null;
  if (opportunity.candidacy.state === "research-required") return "research-required";
  if (opportunity.candidacy.state === "suppressed") return "suppressed";
  if (opportunity.stage.owner === "agent") return "agent-blocked";
  if (opportunity.stage.owner === "user") return "user-owned";
  if (opportunity.stage.owner === "external") return "external-owned";
  return null;
}

function priority(item: TodayQueueItem): [number, number, number, number] {
  const opportunity = item.opportunity;
  const attention = ATTENTION_PRIORITY[opportunity.attemptAttention.state];
  const consequence = item.eligible ? 2
    : opportunity.stage.owner === "user" ? 3
      : opportunity.stage.owner === "external" ? 4
        : 7;
  const score = Number.parseFloat(opportunity.score) || 0;
  return [Math.min(attention, consequence), consequence, -score, opportunity.opportunity];
}

function compare(left: TodayQueueItem, right: TodayQueueItem): number {
  const a = priority(left);
  const b = priority(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function buildTodayRunway(opportunities: OpportunitySummary[]): TodayRunway {
  const queue = opportunities
    .filter((opportunity) => opportunity.stage.owner && opportunity.stage.owner !== "none")
    .map((opportunity): TodayQueueItem => {
      const eligible = isGenerationEligible(opportunity);
      return {
        opportunity,
        eligible,
        artifactLabel: artifactLabel(opportunity),
        actionLabel: actionLabel(opportunity),
        attentionLabel: attentionLabel(opportunity),
        exclusion: exclusionFor(opportunity, eligible),
      };
    })
    .sort(compare);
  const eligible = queue.filter((item) => item.eligible);
  const leading = eligible[0] ?? null;
  return {
    leading,
    queue: leading ? queue.filter((item) => item !== leading) : queue,
    eligible,
    researchRequired: queue.filter((item) => item.exclusion === "research-required"),
    suppressed: queue.filter((item) => item.exclusion === "suppressed"),
    agentBlocked: queue.filter((item) => item.exclusion === "agent-blocked"),
    userOwned: queue.filter((item) => item.exclusion === "user-owned"),
    externalOwned: queue.filter((item) => item.exclusion === "external-owned"),
  };
}
