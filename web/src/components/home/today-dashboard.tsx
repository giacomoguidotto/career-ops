"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Ban,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Layers3,
  Loader2,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { CompanyLogo } from "@/components/company-logo";
import { QuickEvaluate } from "@/components/quick-evaluate";
import { useJobs } from "@/components/jobs/job-store";
import { cn } from "@/lib/cn";
import { instrumentSerif } from "@/lib/fonts";
import { buildTodayRunway, type TodayQueueItem, type TodayRunway } from "@/lib/today-runway";
import type { LifecycleOwner, OpportunitySummary } from "@/lib/core/opportunity-lifecycle";

type BatchCandidate = { opportunity: number; expectedStage: string; expectedRevision: string };
type BatchReady = BatchCandidate & { workerId: string };
type BatchResponse = {
  code: "batch-ready" | "nothing-started";
  message: string;
  ready: BatchReady[];
  skipped: Array<{ opportunity: number; code: string; message: string }>;
  groupId: string | null;
};

function expectation(item: TodayQueueItem): BatchCandidate | null {
  const stage = item.opportunity.stage.id;
  return stage ? {
    opportunity: item.opportunity.opportunity,
    expectedStage: stage,
    expectedRevision: item.opportunity.revision,
  } : null;
}

function jobOpportunity(input?: string): number | null {
  try {
    const value = JSON.parse(input ?? "") as { opportunity?: unknown };
    return Number.isSafeInteger(value.opportunity) ? Number(value.opportunity) : null;
  } catch {
    return null;
  }
}

export function TodayDashboard({
  opportunities,
  inBetween,
}: {
  opportunities: OpportunitySummary[];
  inBetween: boolean;
}) {
  const runway = useMemo(() => buildTodayRunway(opportunities), [opportunities]);
  const { jobs, startJob } = useJobs();
  const router = useRouter();
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [hasCli, setHasCli] = useState(false);
  const batchTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreBatchFocusRef = useRef(false);
  const dateLabel = useMemo(
    () => new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }),
    [],
  );

  useEffect(() => {
    try {
      setHasCli(Boolean(JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId));
    } catch {
      setHasCli(false);
    }
  }, []);
  const canGenerate = hasCli && !inBetween;
  const closeBatch = useCallback(() => {
    restoreBatchFocusRef.current = true;
    setBatchOpen(false);
  }, []);
  useEffect(() => {
    if (!batchOpen && restoreBatchFocusRef.current) {
      restoreBatchFocusRef.current = false;
      batchTriggerRef.current?.focus();
    }
  }, [batchOpen]);

  const start = (candidate: BatchCandidate & { workerId?: string }, item?: TodayQueueItem, batchId?: string) => startJob({
    workerId: candidate.workerId,
    title: item ? `Prepare ${item.artifactLabel}` : `Prepare Opportunity #${candidate.opportunity}`,
    subtitle: item ? `${item.opportunity.company} · ${item.opportunity.role}` : `Opportunity #${candidate.opportunity}`,
    kind: "lifecycle",
    input: JSON.stringify(candidate),
    page: "/",
    batchId,
  });

  const running = new Set(
    jobs
      .filter((job) => job.kind === "lifecycle" && job.status === "running")
      .map((job) => jobOpportunity(job.input))
      .filter((value): value is number => value !== null),
  );
  const leadingWorker = runway.leading
    ? jobs.find((job) => (
      job.kind === "lifecycle"
      && job.status === "running"
      && jobOpportunity(job.input) === runway.leading?.opportunity.opportunity
    ))
    : undefined;

  const generateOne = () => {
    if (!runway.leading) return;
    const candidate = expectation(runway.leading);
    if (!candidate) return;
    const id = start(candidate, runway.leading);
    setBatchMessage(id ? `Starting ${runway.leading.artifactLabel} for ${runway.leading.opportunity.company}.` : "Nothing started.");
  };

  useEffect(() => {
    const onJobDone = () => router.refresh();
    window.addEventListener("co-job-done", onJobDone);
    return () => window.removeEventListener("co-job-done", onJobDone);
  }, [router]);

  return (
    <div className="mx-auto max-w-[88rem] px-5 py-9 sm:px-7 lg:py-12 max-sm:pb-28">
      <header>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-faint">// today · {dateLabel}</p>
        <div className="mt-2 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className={cn(instrumentSerif.className, "text-4xl leading-none text-landing sm:text-5xl")}>
              Keep the search moving.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              Priority and urgency lead one mixed supervision queue. Ownership stays visible before anything starts.
            </p>
          </div>
          <div className="flex items-center gap-4 border-l border-border pl-4 text-sm" aria-label="Today queue summary">
            <QueueMetric value={runway.eligible.length} label="safe to generate" />
            <QueueMetric value={runway.researchRequired.length + runway.suppressed.length + runway.agentBlocked.length} label="need review" warn />
            <QueueMetric value={runway.userOwned.length + runway.externalOwned.length} label="navigate only" />
          </div>
        </div>
        {inBetween && <QuickEvaluate />}
      </header>

      {batchMessage && (
        <div role="status" className="mt-6 rounded-xl border border-border bg-surface/45 px-4 py-3 text-sm text-muted">
          {batchMessage}
        </div>
      )}

      {runway.leading ? (
        <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <main className="min-w-0">
            <LeadingAction
              item={runway.leading}
              running={running.has(runway.leading.opportunity.opportunity)}
              currentPhase={leadingWorker?.steps.at(-1)?.label}
              canGenerate={canGenerate}
              setupIncomplete={inBetween}
              onGenerate={generateOne}
            />
            <section className="mt-9" aria-labelledby="prioritized-queue-title">
              <div className="flex flex-wrap items-center gap-2">
                <Layers3 className="size-4 text-brand" />
                <h2 id="prioritized-queue-title" className="text-sm font-semibold uppercase tracking-[0.14em] text-muted">Prioritized queue</h2>
                <span className="text-xs text-faint">· mixed ownership, one order</span>
              </div>
              <div className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/35">
                {runway.queue.map((item) => <QueueRow key={item.opportunity.opportunity} item={item} />)}
              </div>
            </section>
          </main>

          <aside className="space-y-5 xl:sticky xl:top-6 xl:self-start">
            <section className="rounded-2xl border border-border bg-surface/50 p-5">
              <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-brand" /><h2 className="font-semibold">Safe batch</h2></div>
              <p className="mt-2 text-sm leading-relaxed text-muted">Review the displayed set, then recheck every Stage and revision before starting eligible Agent-owned work.</p>
              <div className="mt-4 space-y-2 text-xs">
                <CountRow label="Eligible now" value={runway.eligible.length} tone="good" />
                <CountRow label="Research or suppressed" value={runway.researchRequired.length + runway.suppressed.length} tone="warn" />
                <CountRow label="User or External" value={runway.userOwned.length + runway.externalOwned.length} />
              </div>
              <button
                ref={batchTriggerRef}
                type="button"
                disabled={!canGenerate || runway.eligible.length === 0}
                onClick={() => setBatchOpen(true)}
                className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-brand/35 bg-brand-soft px-3 text-sm font-semibold text-brand-text transition hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-55"
              >
                Review eligible batch <ArrowRight className="size-4" />
              </button>
              {!canGenerate && <Link href="/config" className="mt-3 block text-center text-xs text-brand-text hover:underline">{inBetween ? "Finish setup to generate" : "Configure a CLI to generate"}</Link>}
            </section>
            <OwnershipKey />
          </aside>
        </div>
      ) : (
        <div className="mt-8 rounded-2xl border border-border bg-surface/35 px-6 py-10 text-center">
          <ShieldCheck className="mx-auto size-6 text-brand" />
          <h2 className={cn(instrumentSerif.className, "mt-3 text-3xl text-landing")}>Nothing needs generation.</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted">Review the navigation-only queue below or open Pipeline for full Opportunity context.</p>
          {runway.queue.length > 0 && (
            <div className="mx-auto mt-6 max-w-3xl divide-y divide-border overflow-hidden rounded-2xl border border-border text-left">
              {runway.queue.map((item) => <QueueRow key={item.opportunity.opportunity} item={item} />)}
            </div>
          )}
        </div>
      )}

      {batchOpen && (
        <BatchReview
          runway={runway}
          onClose={closeBatch}
          onResult={setBatchMessage}
          onStart={(candidate, batchId) => start(candidate, runway.eligible.find((item) => item.opportunity.opportunity === candidate.opportunity), batchId)}
        />
      )}
    </div>
  );
}

function LeadingAction({ item, running, currentPhase, canGenerate, setupIncomplete, onGenerate }: { item: TodayQueueItem; running: boolean; currentPhase?: string; canGenerate: boolean; setupIncomplete: boolean; onGenerate: () => void }) {
  const opportunity = item.opportunity;
  return (
    <section className="dot-bg overflow-hidden rounded-2xl border border-brand/35 bg-gradient-to-br from-brand/10 via-surface/70 to-surface/30 p-5 sm:p-6" aria-labelledby="leading-action-title">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-end">
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-text">Leading eligible Agent-owned Opportunity</p>
          <div className="mt-3 flex items-start gap-3">
            <CompanyLogo name={opportunity.company} size={40} />
            <div className="min-w-0">
              <h2 id="leading-action-title" className={cn(instrumentSerif.className, "text-3xl leading-tight text-landing")}>Prepare {opportunity.company}&apos;s {item.artifactLabel}.</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{opportunity.role}. Generation prepares a local artifact only. It cannot contact anyone or record real-world progress.</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <OwnerBadge owner={opportunity.stage.owner} />
            <MetaBadge label="Stage" value={opportunity.stage.label} />
            <MetaBadge label="Attention" value={item.attentionLabel} />
            <MetaBadge label="Suggests" value={item.actionLabel} accent />
          </div>
        </div>
        <div>
          <button
            type="button"
            disabled={running || !canGenerate}
            onClick={onGenerate}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground transition hover:bg-brand-200 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {running ? <LockKeyhole className="size-4" /> : <Sparkles className="size-4" />}
            {running ? "Already running" : `Generate one: ${item.artifactLabel}`}
          </button>
          {running && <p className="mt-2 text-center text-xs text-muted" aria-label="Current worker phase">{currentPhase ?? "Working"}</p>}
          {!canGenerate && <Link href="/config" className="mt-3 block text-center text-xs text-brand-text hover:underline">{setupIncomplete ? "Finish setup first" : "Configure a CLI first"}</Link>}
        </div>
      </div>
    </section>
  );
}

function QueueRow({ item }: { item: TodayQueueItem }) {
  const opportunity = item.opportunity;
  return (
    <article className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 gap-3">
        <CompanyLogo name={opportunity.company} size={30} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{opportunity.company}</h3>
            <OwnerBadge owner={opportunity.stage.owner} />
          </div>
          <p className="truncate text-xs text-muted">#{String(opportunity.opportunity).padStart(3, "0")} · {opportunity.role}</p>
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
            <Fact label="Stage" value={opportunity.stage.label} />
            <Fact label="Attention" value={item.attentionLabel} />
            <Fact label="Suggests" value={item.actionLabel} />
          </dl>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        <Exclusion item={item} />
        <Link href={`/pipeline/${opportunity.opportunity}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-faint transition hover:bg-surface-hover hover:text-brand-text" aria-label={`Open ${opportunity.company} Opportunity`}>
          <ChevronRight className="size-4" />
        </Link>
      </div>
    </article>
  );
}

function BatchReview({ runway, onClose, onResult, onStart }: {
  runway: TodayRunway;
  onClose: () => void;
  onResult: (message: string) => void;
  onStart: (candidate: BatchReady, batchId: string) => string | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && dialogRef.current) {
        const controls = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);

  const confirm = async () => {
    setBusy(true);
    const candidates = runway.eligible.map(expectation).filter((item): item is BatchCandidate => item !== null);
    const reviewed = runway.suppressed
      .map(expectation)
      .filter((item): item is BatchCandidate => item !== null);
    try {
      const response = await fetch("/api/opportunities/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidates, reviewed }),
      });
      const result = await response.json() as BatchResponse;
      if (!response.ok) throw new Error("Batch preflight failed.");
      if (result.ready.length === 0) {
        onResult("Nothing started. The fresh preflight found no unchanged eligible work.");
      } else {
        if (!result.groupId) throw new Error("Batch identity was not persisted.");
        const started = result.ready.filter((candidate) => onStart(candidate, result.groupId!)).length;
        const skipped = result.skipped.length;
        onResult(`Starting ${started} eligible work item${started === 1 ? "" : "s"}.${skipped ? ` Skipped ${skipped} changed or excluded Opportunit${skipped === 1 ? "y" : "ies"}.` : ""}`);
      }
      onClose();
    } catch {
      onResult("Nothing started. The fresh batch preflight could not be completed.");
      setBusy(false);
    }
  };

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="batch-review-title">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-border bg-background shadow-2xl sm:rounded-3xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-5 sm:px-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand-text">Explicit safe batch</p>
            <h2 id="batch-review-title" className={cn(instrumentSerif.className, "mt-1 text-3xl text-landing")}>Review what may start</h2>
            <p className="mt-1 text-sm text-muted">Confirmation rereads canonical eligibility, Stage, and revision.</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close batch review" className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface-hover"><X className="size-5" /></button>
        </header>
        <div className="p-5 sm:p-6">
          <ReviewGroup title="Included Agent-owned work" items={runway.eligible} icon={CheckCircle2} tone="good" />
          <div className="mt-5 rounded-xl border border-border bg-surface/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Excluded by design</p>
            <div className="mt-3 space-y-4">
              <ReviewGroup title="Research required" items={runway.researchRequired} icon={Search} tone="warn" compact />
              <ReviewGroup title="Suppressed" items={runway.suppressed} icon={Ban} tone="warn" compact />
              <ReviewGroup title="User-owned" items={runway.userOwned} icon={UserRound} compact />
              <ReviewGroup title="External-owned" items={runway.externalOwned} icon={Clock3} compact />
              {runway.agentBlocked.length > 0 && <ReviewGroup title="Other Agent blocks" items={runway.agentBlocked} icon={LockKeyhole} tone="warn" compact />}
            </div>
          </div>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-4 text-sm font-medium hover:bg-surface-hover">Cancel</button>
            <button type="button" disabled={busy} onClick={confirm} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground hover:bg-brand-200 disabled:opacity-55">
              {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <ShieldCheck className="size-4" />}
              Start {runway.eligible.length} eligible job{runway.eligible.length === 1 ? "" : "s"}
            </button>
          </div>
          <p className="mt-3 text-center text-[11px] text-faint">Generation prepares local artifacts only. Nothing is sent or submitted.</p>
        </div>
      </div>
    </div>
  );
}

function ReviewGroup({ title, items, icon: Icon, tone, compact = false }: { title: string; items: TodayQueueItem[]; icon: React.ComponentType<{ className?: string }>; tone?: "good" | "warn"; compact?: boolean }) {
  return (
    <section aria-label={title}>
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Icon className={cn("size-4", tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted")} />
        <span>{title}</span><span className="text-faint">({items.length})</span>
      </div>
      {!compact && items.length > 0 && <div className="mt-2 space-y-2">{items.map((item) => <ReviewItem key={item.opportunity.opportunity} item={item} />)}</div>}
      {compact && <p className="mt-1 text-xs text-muted">{items.length ? items.map((item) => `#${item.opportunity.opportunity} ${item.opportunity.company}`).join(", ") : "None"}</p>}
    </section>
  );
}

function ReviewItem({ item }: { item: TodayQueueItem }) {
  return <div className="flex items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] p-3"><CompanyLogo name={item.opportunity.company} size={26} /><div className="min-w-0"><p className="truncate text-sm font-semibold">#{item.opportunity.opportunity} · {item.opportunity.company}</p><p className="truncate text-xs text-muted">Prepare {item.artifactLabel}</p></div><span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Included</span></div>;
}

function OwnerBadge({ owner }: { owner: LifecycleOwner | null }) {
  const Icon = owner === "agent" ? Bot : owner === "user" ? UserRound : Clock3;
  const label = owner === "agent" ? "Agent" : owner === "user" ? "You" : owner === "external" ? "External" : "None";
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", owner === "agent" ? "bg-brand-soft text-brand-text" : "bg-surface-hover text-muted")}><Icon className="size-3" />{label}</span>;
}

function Exclusion({ item }: { item: TodayQueueItem }) {
  if (item.eligible) return <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Batch eligible</span>;
  if (item.exclusion === "research-required") return <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">Research required</span>;
  if (item.exclusion === "suppressed") return <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">Suppressed</span>;
  if (item.exclusion === "agent-blocked") return <span className="text-[11px] font-medium text-amber-700 dark:text-amber-300">Generation blocked</span>;
  return <span className="text-[11px] font-medium text-muted">Navigate only</span>;
}

function Fact({ label, value }: { label: string; value: string }) { return <div><dt className="inline font-semibold text-muted">{label}: </dt><dd className="inline">{value}</dd></div>; }
function MetaBadge({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) { return <span className={cn("rounded-md border px-2 py-1", accent ? "border-brand/25 bg-brand-soft font-medium text-brand-text" : "border-border bg-surface/60 text-muted")}><span className="sr-only">{label}: </span>{value}</span>; }
function QueueMetric({ value, label, warn = false }: { value: number; label: string; warn?: boolean }) { return <div><strong className={cn("block text-xl font-semibold tabular-nums", warn && "text-amber-700 dark:text-amber-300")}>{value}</strong><span className="text-xs text-faint">{label}</span></div>; }
function CountRow({ label, value, tone }: { label: string; value: number; tone?: "good" | "warn" }) { return <div className="flex items-center justify-between rounded-md bg-surface-hover/60 px-3 py-2"><span>{label}</span><strong className={cn("tabular-nums", tone === "good" && "text-emerald-700 dark:text-emerald-300", tone === "warn" && "text-amber-700 dark:text-amber-300")}>{value}</strong></div>; }

function OwnershipKey() {
  return (
    <section className="rounded-2xl border border-border bg-surface/35 p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Ownership is the guardrail</p>
      <h2 className="mt-1 font-semibold">Who can move the next Stage?</h2>
      <div className="mt-4 space-y-3 text-xs text-muted">
        <div className="flex gap-2"><Bot className="size-4 shrink-0 text-brand" /><span><strong className="block text-foreground">Agent</strong>Explicit artifact generation</span></div>
        <div className="flex gap-2"><UserRound className="size-4 shrink-0" /><span><strong className="block text-foreground">You</strong>Action outside career-ops</span></div>
        <div className="flex gap-2"><Clock3 className="size-4 shrink-0" /><span><strong className="block text-foreground">External</strong>Wait or reported event</span></div>
      </div>
    </section>
  );
}
