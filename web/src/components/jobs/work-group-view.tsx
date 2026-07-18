"use client";

import Link from "next/link";
import { AlertTriangle, ArrowLeft, Check, CheckCheck, ExternalLink, Loader2, RotateCcw } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { GROUP_CHILD_OUTCOMES, type ProjectedGroupChild, type ProjectedWorkGroup } from "@/lib/core/work-group";
import { cn } from "@/lib/cn";

export function WorkGroupView({ group }: { group: ProjectedWorkGroup }) {
  const { jobs, actOnJob, acknowledgeJob } = useJobs();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-7">
      <Link href="/jobs" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted hover:text-brand-text"><ArrowLeft className="size-4" /> Worker history</Link>
      <header className="mt-4 rounded-2xl border border-border bg-surface/40 p-5 sm:p-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand-text">Canonical work group</p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div><h1 className="font-display text-3xl text-landing">{group.title}</h1><p className="mt-1 text-sm text-muted">One durable identity owns {group.children.length} child outcomes. Sibling failures never erase completed work.</p></div>
          {group.attentionCount > 0 && <span className="rounded-md bg-amber-500/15 px-2.5 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">{group.attentionCount} need attention</span>}
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-label="Group outcome summary">
          {GROUP_CHILD_OUTCOMES.map((outcome) => <div key={outcome} className="rounded-lg border border-border bg-background/40 p-3"><dt className="text-[10px] font-semibold uppercase tracking-wide text-faint">{outcome}</dt><dd className="mt-1 text-xl font-semibold tabular-nums">{group.summary[outcome]}</dd></div>)}
        </dl>
      </header>

      <GroupSection title="Active and attention" empty="No active children. Processed terminal work has left the active queue." children={group.activeChildren} render={(child) => <ChildCard child={child} job={byId.get(child.workerId)} actOnJob={actOnJob} acknowledgeJob={acknowledgeJob} />} />
      <GroupSection title="History" empty="No terminal child outcomes yet." children={group.historyChildren} render={(child) => <ChildCard child={child} job={byId.get(child.workerId)} actOnJob={actOnJob} acknowledgeJob={acknowledgeJob} history />} />
    </div>
  );
}

function GroupSection({ title, empty, children, render }: { title: string; empty: string; children: ProjectedGroupChild[]; render: (child: ProjectedGroupChild) => React.ReactNode }) {
  return <section className="mt-8" aria-labelledby={`group-${title.toLowerCase().replaceAll(" ", "-")}`}><h2 id={`group-${title.toLowerCase().replaceAll(" ", "-")}`} className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">{title}</h2>{children.length ? <div className="mt-3 space-y-3">{children.map((child) => <div key={child.workerId}>{render(child)}</div>)}</div> : <p className="mt-3 rounded-xl border border-dashed border-border p-5 text-sm text-muted">{empty}</p>}</section>;
}

function ChildCard({ child, job, actOnJob, acknowledgeJob, history = false }: { child: ProjectedGroupChild; job?: ReturnType<typeof useJobs>["jobs"][number]; actOnJob: (id: string) => void; acknowledgeJob: (id: string) => void; history?: boolean }) {
  const running = child.state === "active" || child.state === "queued";
  const Icon = running ? Loader2 : ["changed", "recovered", "unchanged"].includes(child.outcome ?? "") ? Check : AlertTriangle;
  const canContinue = child.nextAction && ["retry", "resume"].includes(child.nextAction.kind) && job && job.status !== "running";
  return <article className={cn("rounded-2xl border bg-surface/35 p-4 sm:p-5", child.completedButUnmerged ? "border-amber-500/45" : "border-border")}>
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3"><Icon className={cn("mt-0.5 size-4 shrink-0", running && "animate-spin motion-reduce:animate-none", child.outcome && ["changed", "recovered", "unchanged"].includes(child.outcome) ? "text-emerald-500" : "text-amber-500")} /><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">#{child.opportunity} · {child.title}</h3>{child.outcome && <span className="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{child.outcome}</span>}{history && child.state === "attention" && <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">still needs attention</span>}</div>{child.subtitle && <p className="mt-1 text-xs text-muted">{child.subtitle}</p>}<p className="mt-2 text-sm text-muted">{child.message}</p>{child.completedButUnmerged && <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300">Complete artifact exists, but canonical reconciliation has not succeeded.</p>}</div></div>
      <div className="flex shrink-0 flex-col gap-2 sm:min-w-48">{canContinue ? <button type="button" onClick={() => actOnJob(child.workerId)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand px-3 text-sm font-semibold text-brand-foreground"><RotateCcw className="size-4" />{child.nextAction!.label}</button> : child.nextAction?.href ? <Link href={child.nextAction.href} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand px-3 text-sm font-semibold text-brand-foreground">{child.nextAction.label}<ExternalLink className="size-4" /></Link> : null}{child.state === "attention" && job && !child.completedButUnmerged && <button type="button" onClick={() => acknowledgeJob(child.workerId)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm text-muted"><CheckCheck className="size-4" />Acknowledge</button>}{job && <Link href={`/jobs/${child.workerId}`} className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-3 text-sm text-muted hover:bg-surface-hover">Worker details</Link>}</div>
    </div>
    <details className="mt-4 rounded-lg border border-border bg-background/30 p-3"><summary className="cursor-pointer text-xs font-semibold text-muted">Canonical evidence and diagnostics</summary><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2"><div><dt className="font-semibold text-faint">Stage</dt><dd className="break-all text-muted">{child.canonicalEvidence.stage}</dd></div><div><dt className="font-semibold text-faint">Revision</dt><dd className="break-all text-muted">{child.canonicalEvidence.revision}</dd></div><div><dt className="font-semibold text-faint">Action</dt><dd className="break-all text-muted">{child.canonicalEvidence.action ?? "none"}</dd></div><div><dt className="font-semibold text-faint">Worker</dt><dd className="break-all text-muted">{child.workerId}</dd></div></dl>{child.artifacts.length > 0 && <ul className="mt-3 space-y-2 text-xs text-muted">{child.artifacts.map((artifact, index) => <li key={`${artifact.kind}-${index}`} className="break-all rounded bg-surface-hover/60 p-2">{artifact.kind}: {artifact.state}, {artifact.format}{artifact.path ? `, ${artifact.path}` : ""}</li>)}</ul>}</details>
  </article>;
}
