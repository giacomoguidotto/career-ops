import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  FileCheck2,
  FileText,
  History,
  MapPin,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { OpportunityWorkspace } from "@/lib/career-ops";
import type { LifecycleContract, OpportunitySummary } from "@/lib/core/opportunity-lifecycle";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { GeneratePdfButton } from "@/components/generate-pdf-button";
import { ApplyButton } from "@/components/apply-button";
import { GuidedApproach } from "@/components/guided-approach";
import { parseApproachPlan } from "@/lib/approach-plan.mjs";
import { parseReport, scoreNum, scoreTone } from "@/lib/format";
import { cn } from "@/lib/cn";
import { CandidacyCoordination } from "@/components/candidacy-coordination";
import { ReportedEventLauncher } from "@/components/reported-event";
import { ResumeReconciliation } from "@/components/resume-reconciliation";

type Stage = LifecycleContract["stages"][number];
type Artifact = OpportunitySummary["artifacts"][number];

const sectionLinks = [
  ["overview", "Overview"],
  ["initial-evaluation", "Initial evaluation"],
  ["approach-plan", "Approach Plan"],
  ["materials", "Materials"],
  ["attempts", "Attempts"],
  ["history", "History"],
] as const;

function words(value: string | null): string {
  if (!value) return "";
  return value
    .replace(/^generate_/, "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourcePaths(records: Array<Record<string, unknown>>): string[] {
  return [...new Set(records
    .map((record) => typeof record.path === "string" ? record.path : null)
    .filter((path): path is string => Boolean(path)))];
}

function warningLabel(warning: Record<string, unknown>): string {
  const code = typeof warning.code === "string" ? warning.code : "capability-unavailable";
  return words(code.replaceAll("-", "_"));
}

function stageById(contract: LifecycleContract, id: string): Stage | null {
  return contract.stages.find((stage) => stage.id === id) ?? null;
}

function previousStage(contract: LifecycleContract, current: Stage): Stage | null {
  const candidates = contract.stages.filter((stage) => stage.allowedSuccessors.includes(current.id));
  if (candidates.length === 0) return null;
  const currentIndex = contract.stages.findIndex((stage) => stage.id === current.id);
  return candidates
    .filter((stage) => contract.stages.indexOf(stage) < currentIndex)
    .at(-1) ?? candidates[0];
}

function LifecycleStrip({ contract, opportunity }: { contract: LifecycleContract; opportunity: OpportunitySummary }) {
  const current = opportunity.stage.id ? stageById(contract, opportunity.stage.id) : null;
  const previous = current ? previousStage(contract, current) : null;
  const successors = current
    ? current.allowedSuccessors.map((id) => stageById(contract, id)).filter((stage): stage is Stage => Boolean(stage))
    : [];
  const agentMade = Boolean(current?.producedBy && current.owner === "user");
  const nextLabel = successors.length === 0
    ? current?.owner === "none" ? "Complete" : "Blocked"
    : successors.length === 1 ? successors[0].label : `${successors[0].label} +${successors.length - 1}`;
  const nextDescription = successors.length
    ? successors.map((stage) => stage.label).join(", ")
    : current?.owner === "none" ? "No further Stage" : opportunity.primaryAction.reason ?? "No canonical successor";

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-xs"
      aria-label={`Lifecycle: previous ${previous?.label ?? "none"}, current ${opportunity.stage.label}, next ${nextDescription}`}
    >
      <LifecyclePosition eyebrow="Previous" label={previous?.label ?? "Start"} muted />
      <ArrowRight className="size-3.5 text-faint" aria-hidden="true" />
      <div className="min-w-0 rounded-xl border border-brand/35 bg-brand-soft px-3 py-2.5 text-center text-brand-text">
        <span className="block font-mono text-[9px] uppercase tracking-[0.14em]">Current</span>
        <span className="mt-0.5 flex items-center justify-center gap-1.5 font-semibold">
          {agentMade && <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />}
          <span className="truncate">{opportunity.stage.label}</span>
        </span>
        {agentMade && <span className="mt-0.5 block text-[9px] font-medium uppercase tracking-wide">Agent-made</span>}
      </div>
      <ArrowRight className="size-3.5 text-faint" aria-hidden="true" />
      <LifecyclePosition eyebrow="Allowed next" label={nextLabel} title={nextDescription} muted={successors.length === 0} />
    </div>
  );
}

function LifecyclePosition({ eyebrow, label, title, muted = false }: { eyebrow: string; label: string; title?: string; muted?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-xl border border-border bg-surface/55 px-3 py-2.5 text-center", muted && "text-muted")} title={title}>
      <span className="block font-mono text-[9px] uppercase tracking-[0.14em] text-faint">{eyebrow}</span>
      <span className="mt-0.5 block truncate font-medium">{label}</span>
    </div>
  );
}

function primaryCopy(opportunity: OpportunitySummary, hasApproachPlan: boolean, canGuideApproach: boolean): { eyebrow: string; title: string; detail: string; href: string; cta: string } {
  const action = words(opportunity.primaryAction.id);
  switch (opportunity.primaryAction.kind) {
    case "generate":
      return {
        eyebrow: "Agent-owned next step",
        title: action ? `Prepare ${action}` : "Prepare the next artifact",
        detail: "Start generation from Today. This page stays passive and will show the canonical artifact after it exists.",
        href: "/",
        cta: "Open Today",
      };
    case "act-outside":
      if (opportunity.primaryAction.id !== "execute_approach") {
        return {
          eyebrow: "Your next step",
          title: action || "Act outside career-ops",
          detail: "Review the prepared material, act outside career-ops, then report exactly what happened. Viewing the artifact records nothing.",
          href: "#materials",
          cta: "Review prepared materials",
        };
      }
      if (!hasApproachPlan) {
        return {
          eyebrow: "Your next step",
          title: action || "Act outside career-ops",
          detail: "The canonical Approach Plan is not readable. Review its artifact status before preparing any external action.",
          href: "#approach-plan",
          cta: "Review Approach Plan",
        };
      }
      if (!canGuideApproach) {
        return {
          eyebrow: "Your next step",
          title: action || "Act outside career-ops",
          detail: "Review the readable Approach Plan. Its format has no compatible ranked route that guided preparation can safely interpret.",
          href: "#approach-plan",
          cta: "Review Approach Plan",
        };
      }
      return {
        eyebrow: "Your next step",
        title: action || "Act outside career-ops",
        detail: "Review the prepared material, act outside career-ops, then report exactly what happened. Viewing or copying records nothing.",
        href: "#guided-approach",
        cta: "Start guided approach",
      };
    case "wait":
      return {
        eyebrow: "External-owned wait",
        title: "Wait for the next hiring event",
        detail: "There is no action to automate. Review the confirmed Attempts and cadence without changing the factual Stage.",
        href: "#attempts",
        cta: "Review Attempts",
      };
    case "terminal":
      return {
        eyebrow: "Terminal Stage",
        title: `${opportunity.stage.label} is complete`,
        detail: "No canonical successor is available. The durable evidence and history remain available below.",
        href: "#history",
        cta: "Review history",
      };
    default:
      return {
        eyebrow: "Next step unavailable",
        title: "Review the canonical block",
        detail: "The lifecycle contract cannot safely offer an action for this Opportunity.",
        href: "#readiness",
        cta: "Review readiness",
      };
  }
}

function SourceCue({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-hover px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
      <FileText className="size-3" aria-hidden="true" /> Source: {children}
    </span>
  );
}

function RecommendationCue({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-brand-text">
      <Sparkles className="size-3" aria-hidden="true" /> Recommendation: {children}
    </span>
  );
}

function ArtifactState({ artifact }: { artifact: Artifact }) {
  const needsReview = artifact.acceptance?.status === "needs-review";
  const available = artifact.state === "available" && !needsReview;
  const Icon = available ? FileCheck2 : artifact.state === "missing" ? CircleDashed : AlertTriangle;
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
      available ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : artifact.state === "missing" ? "bg-surface-hover text-muted" : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    )}>
      <Icon className="size-3" aria-hidden="true" /> {needsReview ? "needs review" : artifact.state}
    </span>
  );
}

function ContextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-faint">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Readiness({ opportunity }: { opportunity: OpportunitySummary }) {
  const rows = [
    ["Passive read", opportunity.capabilities.passiveRead],
    ["Generate", opportunity.capabilities.generate],
    ["Record Attempt", opportunity.capabilities.recordAttempt],
    ["Report successor", opportunity.capabilities.reportSuccessor],
    ["Open artifacts", opportunity.capabilities.openArtifacts],
  ] as const;
  return (
    <section id="readiness" aria-labelledby="readiness-heading" className="mt-5 border-t border-border pt-5 scroll-mt-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-brand" aria-hidden="true" />
        <h2 id="readiness-heading" className="text-sm font-semibold">Readiness</h2>
      </div>
      <ul className="mt-3 space-y-2.5 text-xs">
        {rows.map(([label, ready]) => (
          <li key={label} className="flex items-center justify-between gap-3">
            <span className="text-muted">{label}</span>
            <span className={cn("inline-flex items-center gap-1 font-medium", ready ? "text-emerald-700 dark:text-emerald-400" : "text-faint")}>
              {ready ? <CheckCircle2 className="size-3.5" aria-hidden="true" /> : <CircleDashed className="size-3.5" aria-hidden="true" />}
              {ready ? "Available" : "Unavailable"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  return (
    <article className="min-w-0 rounded-xl border border-border bg-surface/45 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{words(artifact.kind.replaceAll("-", "_"))}</p>
          <p className="mt-1 text-xs text-muted">Format: {artifact.format}</p>
        </div>
        <ArtifactState artifact={artifact} />
      </div>
      {artifact.path && <p className="mt-3 break-all font-mono text-[10px] leading-relaxed text-faint">Source: {artifact.path}</p>}
      {artifact.acceptance && (
        <div className={cn("mt-3 rounded-lg p-3 text-xs", artifact.acceptance.status === "accepted" ? "bg-emerald-500/[0.07]" : "bg-amber-500/[0.08]")}>
          <p className="font-semibold">
            {artifact.acceptance.actualPages} {artifact.acceptance.actualPages === 1 ? "page" : "pages"} · {artifact.acceptance.budget}-page budget
          </p>
          {artifact.acceptance.status === "needs-review" && <p className="mt-1 leading-relaxed text-muted">{artifact.acceptance.trimGuidance}</p>}
          {artifact.acceptance.acceptedBy === "explicit-overflow" && <p className="mt-1 text-muted">Accepted through an explicit page-count allowance.</p>}
        </div>
      )}
    </article>
  );
}

export function OpportunityView({ workspace }: { workspace: OpportunityWorkspace }) {
  const { detail, report, textArtifacts } = workspace;
  const { contract, opportunity, attempts } = detail;
  const reportMeta = report ? parseReport(report.content) : null;
  const reportUrl = reportMeta?.fields.find((field) => field.label === "URL")?.value;
  const score = scoreNum(opportunity.score);
  const warnings = [...opportunity.warnings, ...detail.warnings]
    .filter((warning, index, all) => all.findIndex((candidate) => candidate.code === warning.code) === index);
  const approachArtifact = opportunity.artifacts.find((artifact) => artifact.kind === "approach-plan");
  const approachPlan = textArtifacts["approach-plan"];
  const pdfArtifact = opportunity.artifacts.find((artifact) => artifact.kind === "pdf");
  const pdfReady = Boolean(
    pdfArtifact
    && pdfArtifact.state === "available"
    && (!pdfArtifact.acceptance || pdfArtifact.acceptance.status === "accepted"),
  );
  const hasGuideableRoutes = approachArtifact?.format === "canonical" && approachPlan
    ? (parseApproachPlan(approachPlan.content) as unknown[]).length > 0
    : false;
  const canGuideApproach = opportunity.primaryAction.kind === "act-outside"
    && opportunity.primaryAction.id === "execute_approach"
    && hasGuideableRoutes;
  const strandedArtifact = opportunity.stage.owner === "agent" && opportunity.stage.suggests
    ? opportunity.artifacts.find((artifact) => (
      artifact.action === opportunity.stage.suggests
      && artifact.expectedAction === opportunity.stage.suggests
      && artifact.state === "available"
      && ["canonical", "legacy"].includes(artifact.format)
    ))
    : undefined;
  const primary = strandedArtifact ? {
    eyebrow: "Existing artifact needs reconciliation",
    title: `Resume ${words(strandedArtifact.kind.replaceAll("-", "_"))}`,
    detail: "The canonical artifact already exists. Resume reconciliation without regenerating it or inferring a Stage.",
    href: "#materials",
    cta: "Resume reconciliation",
  } : primaryCopy(opportunity, Boolean(approachPlan), canGuideApproach);
  const provenance = sourcePaths([...contract.provenance, ...opportunity.provenance]);
  const primaryBlocked = opportunity.primaryAction.kind === "generate" && !opportunity.primaryAction.enabled;

  return (
    <div className="min-w-0 pb-32 lg:pb-0">
      <header className="border-b border-border px-5 py-6 sm:px-8 lg:px-10">
        <Link href="/pipeline" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand-text">
          <ArrowLeft className="size-4" aria-hidden="true" /> Pipeline
        </Link>
        <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3.5">
            <CompanyLogo name={opportunity.company} size={44} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">Opportunity #{String(opportunity.opportunity).padStart(3, "0")}</p>
                {opportunity.score && <Badge tone={scoreTone(opportunity.score)}>{opportunity.score}</Badge>}
                {Number.isFinite(score) && <Badge tone={score >= 4 ? "good" : "muted"}>{score >= 4 ? "Recommended" : "Below apply line"}</Badge>}
              </div>
              <h1 className="mt-1 break-words font-display text-3xl tracking-tight text-landing sm:text-4xl">{opportunity.company}</h1>
              <p className="mt-1 break-words text-sm text-muted sm:text-base">{opportunity.role}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {opportunity.location && (
              <span className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-surface/60 px-2.5">
                <MapPin className="size-3.5" aria-hidden="true" /> {opportunity.location}
              </span>
            )}
            {reportUrl?.startsWith("http") && (
              <a href={reportUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 px-2 text-brand-text hover:underline">
                Job posting <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[90rem] lg:grid-cols-[12rem_minmax(0,1fr)_18rem]">
        <nav aria-label="Opportunity sections" className="border-b border-border px-4 py-3 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:py-6">
          <div className="flex gap-1 overflow-x-auto lg:flex-col">
            {sectionLinks.map(([id, label]) => (
              <a key={id} href={`#${id}`} className="inline-flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 lg:w-full">
                {label}
              </a>
            ))}
          </div>
        </nav>

        <div className="min-w-0 px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
          <section id="overview" aria-labelledby="overview-heading" className="scroll-mt-6">
            <h2 id="overview-heading" className="sr-only">Overview</h2>
            <LifecycleStrip contract={contract} opportunity={opportunity} />

            <div className="dot-bg mt-6 overflow-hidden rounded-2xl border border-brand/35 bg-surface/70 bg-gradient-to-br from-brand/10 via-transparent to-transparent p-5 shadow-sm sm:p-6">
              <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
                <div className="min-w-0 max-w-2xl">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-text">{primary.eyebrow}</p>
                    <RecommendationCue>canonical lifecycle</RecommendationCue>
                  </div>
                  <h2 className="mt-2 font-display text-3xl leading-tight text-landing">{primary.title}</h2>
                  <p className="mt-3 text-sm leading-relaxed text-muted">{primary.detail}</p>
                  {primaryBlocked && (
                    <div role="status" className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-sm text-amber-800 dark:text-amber-200">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      <span>Blocked: {words((opportunity.primaryAction.reason ?? "capability_unavailable").replaceAll("-", "_"))}</span>
                    </div>
                  )}
                </div>
                <div className="w-full shrink-0 xl:w-48">
                  {strandedArtifact && opportunity.stage.id ? (
                    <ResumeReconciliation opportunity={opportunity.opportunity} expectedStage={opportunity.stage.id} expectedRevision={opportunity.revision} />
                  ) : (
                    <Link href={primary.href} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
                      {primary.cta} <ArrowRight className="size-4" aria-hidden="true" />
                    </Link>
                  )}
                  <p className="mt-2 text-center text-[11px] text-faint">{strandedArtifact ? "Uses the canonical lifecycle seam" : "Navigation only, no fact is recorded"}</p>
                </div>
              </div>
            </div>

            {warnings.length > 0 && (
              <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4" role="status" aria-label="Canonical blocks and warnings">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="size-4 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                  <h2 className="text-sm font-semibold">Blocks and compatibility notes</h2>
                </div>
                <ul className="mt-2 space-y-1 text-sm text-muted">
                  {warnings.map((warning, index) => <li key={`${String(warning.code)}-${index}`}>{warningLabel(warning)}</li>)}
                </ul>
              </div>
            )}
          </section>

          <section id="initial-evaluation" aria-labelledby="evaluation-heading" className="mt-12 scroll-mt-6 border-t border-border pt-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Durable evidence</p>
                <h2 id="evaluation-heading" className="mt-1 font-display text-3xl text-landing">Initial evaluation</h2>
              </div>
              <SourceCue>{report?.file ?? "report unavailable"}</SourceCue>
            </div>
            {report ? (
              <article className="report-prose mt-5" aria-label="Evaluation report">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportMeta?.body ?? report.content}</ReactMarkdown>
              </article>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-border bg-surface/30 p-5 text-sm text-muted">No readable evaluation report is available.</div>
            )}
          </section>

          <section id="approach-plan" aria-labelledby="approach-heading" className="mt-12 scroll-mt-6 border-t border-border pt-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Preparation entry point</p>
                <h2 id="approach-heading" className="mt-1 font-display text-3xl text-landing">Approach Plan</h2>
              </div>
              {approachArtifact && <ArtifactState artifact={approachArtifact} />}
            </div>
            {approachPlan ? (
              <>
                <p className="mt-3 text-sm text-muted">Reviewing this plan is passive. Acting outside career-ops and reporting the result are separate steps.</p>
                {canGuideApproach && <GuidedApproach plan={approachPlan.content} opportunity={opportunity} contract={contract} attempts={attempts} />}
                <article className="report-prose mt-5 rounded-2xl border border-border bg-surface/35 p-5" aria-label="Approach Plan artifact">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{approachPlan.content}</ReactMarkdown>
                </article>
              </>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-border bg-surface/30 p-5 text-sm text-muted">
                {approachArtifact?.state === "missing" ? "The canonical Approach Plan has not been generated yet." : "No readable Approach Plan is available for this Stage."}
              </div>
            )}
          </section>

          <section id="materials" aria-labelledby="materials-heading" className="mt-12 scroll-mt-6 border-t border-border pt-8">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Artifact state</p>
              <h2 id="materials-heading" className="mt-1 font-display text-3xl text-landing">Materials</h2>
            </div>
            {opportunity.artifacts.length > 0 ? (
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {opportunity.artifacts.map((artifact, index) => <ArtifactCard key={`${artifact.kind}-${index}`} artifact={artifact} />)}
              </div>
            ) : (
              <p className="mt-5 text-sm text-muted">No lifecycle artifacts are declared for this Opportunity.</p>
            )}
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/35 p-4">
              <GeneratePdfButton
                n={String(opportunity.opportunity)}
                company={opportunity.company}
                pdfReady={pdfReady}
                pdfReview={pdfArtifact?.acceptance?.status === "needs-review" ? {
                  actualPages: pdfArtifact.acceptance.actualPages,
                  budget: pdfArtifact.acceptance.budget,
                  trimGuidance: pdfArtifact.acceptance.trimGuidance,
                  reviewRevision: pdfArtifact.acceptance.reviewRevision,
                } : undefined}
              />
              <ApplyButton n={String(opportunity.opportunity)} url={reportUrl?.startsWith("http") ? reportUrl : undefined} company={opportunity.company} pdfReady={pdfReady} />
              <p className="basis-full text-[11px] text-faint">Application review never submits or sends from this page.</p>
            </div>
          </section>

          <section id="attempts" aria-labelledby="attempts-heading" className="mt-12 scroll-mt-6 border-t border-border pt-8">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Confirmed facts only</p>
                <h2 id="attempts-heading" className="mt-1 font-display text-3xl text-landing">Attempts</h2>
              </div>
              <span className="text-xs text-faint tabular-nums">{attempts.length} recorded</span>
            </div>
            <div className="mt-4"><ReportedEventLauncher opportunity={opportunity} contract={contract} attempts={attempts} /></div>
            {attempts.length > 0 ? (
              <ol className="mt-5 space-y-3">
                {[...attempts].reverse().map((attempt) => (
                  <li key={attempt.id} className="rounded-xl border border-border bg-surface/35 p-4" data-history-type="attempt">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold">{words(attempt.type)}</p>
                        <p className="mt-1 text-sm text-muted">{attempt.channel} · {attempt.recipient}</p>
                      </div>
                      <span className="font-mono text-[10px] text-faint">{attempt.date}</span>
                    </div>
                    <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                      <ContextRow label="Result" value={attempt.result || "Recorded"} />
                      {attempt.followUpTo && <ContextRow label="Follows" value={attempt.followUpTo} />}
                    </dl>
                    {attempt.notes && <p className="mt-3 text-sm leading-relaxed text-muted">{attempt.notes}</p>}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="mt-5 rounded-xl border border-dashed border-border bg-surface/30 p-5 text-sm text-muted">No confirmed Approach Attempt has been recorded.</div>
            )}
          </section>

          <section id="history" aria-labelledby="history-heading" className="mt-12 scroll-mt-6 border-t border-border pt-8">
            <div className="flex items-center gap-3">
              <History className="size-5 text-brand" aria-hidden="true" />
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Typed canonical timeline</p>
                <h2 id="history-heading" className="mt-1 font-display text-3xl text-landing">History</h2>
              </div>
            </div>
            <ol className="mt-5 border-l border-border pl-5">
              {[...attempts].reverse().map((attempt) => (
                <li key={`history-${attempt.id}`} className="relative pb-5" data-history-type="confirmed-attempt">
                  <span className="absolute -left-[1.58rem] top-1.5 size-2 rounded-full bg-sky-500 ring-4 ring-background" aria-hidden="true" />
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">Confirmed Attempt</p>
                  <p className="mt-1 text-sm font-medium">{words(attempt.type)} · {attempt.result}</p>
                  <p className="mt-1 font-mono text-[10px] text-faint">{attempt.date} · {attempt.id}</p>
                </li>
              ))}
              <li className="relative pb-5" data-history-type="stage">
                <span className="absolute -left-[1.58rem] top-1.5 size-2 rounded-full bg-brand ring-4 ring-background" aria-hidden="true" />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-brand-text">Stage snapshot</p>
                <p className="mt-1 text-sm font-medium">Current canonical Stage: {opportunity.stage.label}</p>
                <p className="mt-1 text-xs text-muted">Past Stage changes are not inferred when the canonical contract does not expose them.</p>
              </li>
              {opportunity.artifacts.filter((artifact) => artifact.state === "available").map((artifact, index) => (
                <li key={`history-artifact-${artifact.kind}-${index}`} className="relative pb-5 last:pb-0" data-history-type="artifact">
                  <span className="absolute -left-[1.58rem] top-1.5 size-2 rounded-full bg-emerald-500 ring-4 ring-background" aria-hidden="true" />
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Artifact</p>
                  <p className="mt-1 text-sm font-medium">{words(artifact.kind.replaceAll("-", "_"))} {artifact.acceptance?.status === "needs-review" ? "written, needs review" : "available"}</p>
                  {artifact.path && <p className="mt-1 break-all font-mono text-[10px] text-faint">{artifact.path}</p>}
                </li>
              ))}
            </ol>
            <p className="mt-5 rounded-xl border border-border bg-surface/30 p-4 text-xs leading-relaxed text-muted">
              Approach actions appear here only as confirmed canonical Attempts. Other reported events may change Stage only through a fresh allowed successor. No event is reconstructed from filenames, notes, or UI activity.
            </p>
          </section>
        </div>

        <aside aria-label="Opportunity context" className="border-t border-border bg-surface/20 px-5 py-6 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-l lg:border-t-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Opportunity context</p>
          <CandidacyCoordination opportunity={opportunity} />
          <Readiness opportunity={opportunity} />
          <details className="mt-5 border-t border-border pt-5">
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium">
              <FileText className="size-4 text-brand" aria-hidden="true" /> Provenance
            </summary>
            <ul className="mt-2 space-y-2 text-[10px] text-faint">
              {provenance.map((path) => <li key={path} className="break-all font-mono">{path}</li>)}
            </ul>
          </details>
          <div className="mt-5 border-t border-border pt-5 text-xs text-muted">
            <div className="flex items-center gap-2">
              <Clock3 className="size-4 text-brand" aria-hidden="true" />
              <span>Revision</span>
            </div>
            <p className="mt-2 break-all font-mono text-[9px] text-faint">{opportunity.revision}</p>
          </div>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-20 z-30 px-4 lg:hidden" aria-label="Primary Opportunity action">
        <div className="mx-auto flex max-w-lg items-center gap-3 rounded-2xl border border-brand/35 bg-surface/95 p-2.5 shadow-2xl shadow-black/20 backdrop-blur">
          <div className="min-w-0 pl-1">
            <p className="truncate text-xs font-semibold">{primary.title}</p>
            <p className="truncate text-[10px] text-faint">No fact is recorded here</p>
          </div>
          {strandedArtifact && opportunity.stage.id ? (
            <div className="ml-auto w-48"><ResumeReconciliation opportunity={opportunity.opportunity} expectedStage={opportunity.stage.id} expectedRevision={opportunity.revision} /></div>
          ) : (
            <Link href={primary.href} className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-brand-foreground hover:bg-brand-200">
              {primary.cta} <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
