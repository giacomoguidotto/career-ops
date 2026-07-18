import type {
  LifecycleContract,
  OpportunitySummary,
} from "@/lib/core/opportunity-lifecycle";

export function reportableSuccessors(
  opportunity: OpportunitySummary,
  contract: LifecycleContract,
): string[] {
  const allowed = new Set(opportunity.stage.allowedSuccessors);
  return contract.stages
    .filter((stage) => allowed.has(stage.id) && !stage.onDemand.includes("review_approach"))
    .map((stage) => stage.id);
}
