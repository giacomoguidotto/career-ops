"use client";

import { use } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X, AlertTriangle, RotateCcw, ExternalLink, CheckCheck } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { HeroGlow } from "@/components/hero-glow";
import { Badge } from "@/components/ui/badge";
import { isWorkGroupId } from "@/lib/core/work-group";

export default function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { jobs, actOnJob, acknowledgeJob } = useJobs();
  const job = jobs.find((j) => j.id === id);

  if (!job) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
          <ArrowLeft className="size-4" /> Pipeline
        </Link>
        <p className="mt-8 text-sm text-muted">
          This worker record is unavailable. Durable lifecycle workers normally remain in Workers history after reload.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <Link href="/pipeline" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
        <ArrowLeft className="size-4" /> Pipeline
      </Link>
      {isWorkGroupId(job.batchId) && <Link href={`/jobs/groups/${job.batchId}`} className="ml-4 inline-flex min-h-11 items-center text-sm text-brand-text hover:underline">Open owning work group</Link>}

      <section className="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
        {job.status === "running" && <HeroGlow />}
        <div className="relative z-10">
          <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
            {job.status === "running" ? (
              <><Loader2 className="size-3 animate-spin text-brand" /> working</>
            ) : job.status === "done" ? (
              <><Check className="size-3 text-emerald-500" /> done</>
            ) : (
              <><X className="size-3 text-red-400" /> error</>
            )}
          </p>
          <h1 className="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
          {job.subtitle && <p className="mt-1 text-sm text-muted">{job.subtitle}</p>}
          {job.result?.score != null && (
            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
              {job.result.summary && <span className="text-sm text-muted">{job.result.summary}</span>}
            </div>
          )}
        </div>
      </section>

      {job.recovery && (
        <section className="mt-6 rounded-2xl border border-border bg-surface/40 p-5" aria-labelledby="recovery-title">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 gap-3">
              {["changed", "recovered", "unchanged"].includes(job.recovery.outcome)
                ? <Check className="mt-0.5 size-5 shrink-0 text-emerald-500" aria-hidden="true" />
                : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden="true" />}
              <div>
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-text">{job.recovery.outcome}</p>
                <h2 id="recovery-title" className="mt-1 text-lg font-semibold">{job.recovery.message}</h2>
                {job.recovery.artifact && (
                  <p className="mt-2 break-all text-xs text-muted">Artifact: <code>{job.recovery.artifact.path}</code></p>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:min-w-48">
              {job.recovery.nextAction.href ? (
                <Link href={job.recovery.nextAction.href} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground hover:bg-brand-200">
                  {job.recovery.nextAction.label} <ExternalLink className="size-4" />
                </Link>
              ) : (
                <button type="button" onClick={() => actOnJob(job.id)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground hover:bg-brand-200">
                  <RotateCcw className="size-4" /> {job.recovery.nextAction.label}
                </button>
              )}
              {!job.acknowledgedAt && (
                <button type="button" onClick={() => acknowledgeJob(job.id)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-4 text-sm text-muted hover:bg-surface-hover hover:text-foreground">
                  <CheckCheck className="size-4" /> Acknowledge
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      <ol className="mt-6 space-y-2">
        {job.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            {s.kind === "tool" ? (
              <Wrench className="mt-0.5 size-3.5 shrink-0 text-brand" />
            ) : (
              <CircleDot className="mt-0.5 size-3.5 shrink-0 text-faint" />
            )}
            <span className={s.kind === "tool" ? "font-medium" : "text-muted"}>
              {s.kind === "tool" ? `Using ${s.label}` : s.label}
            </span>
            <time className="ml-auto shrink-0 font-mono text-[10px] text-faint" dateTime={new Date(s.ts).toISOString()}>
              {new Date(s.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </time>
          </li>
        ))}
        {job.status === "running" && (
          <li className="flex items-center gap-2.5 text-sm text-muted">
            <Loader2 className="size-3.5 animate-spin text-brand" /> thinking…
          </li>
        )}
      </ol>

      {job.recoveryHistory && job.recoveryHistory.length > 0 && (
        <section className="mt-8" aria-labelledby="recovery-history-title">
          <h2 id="recovery-history-title" className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Recovery history</h2>
          <ol className="mt-3 space-y-2">
            {job.recoveryHistory.map((recovery, index) => (
              <li key={`${recovery.occurredAt}-${index}`} className="rounded-xl border border-border bg-surface/30 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="capitalize">{recovery.outcome}</strong>
                  <time className="font-mono text-[10px] text-faint" dateTime={recovery.occurredAt}>{new Date(recovery.occurredAt).toLocaleString()}</time>
                </div>
                <p className="mt-1 text-muted">{recovery.message}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      {job.recovery && (
        <details className="mt-8 rounded-xl border border-border bg-surface/25 p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.16em] text-muted">Content-safe diagnostics</summary>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <Diagnostic label="Contract" value={job.recovery.diagnostic.contract ? `${job.recovery.diagnostic.contract.id} v${job.recovery.diagnostic.contract.version}` : "unavailable"} />
            <Diagnostic label="Trigger" value={job.recovery.diagnostic.trigger} />
            <Diagnostic label="Stage" value={job.recovery.diagnostic.stage ?? "unavailable"} />
            <Diagnostic label="Lifecycle code" value={job.recovery.diagnostic.lifecycleCode ?? "none"} />
            <Diagnostic label="Exit" value={job.recovery.diagnostic.exitCode == null ? "none" : String(job.recovery.diagnostic.exitCode)} />
            <Diagnostic label="Signal" value={job.recovery.diagnostic.signal ?? "none"} />
          </dl>
          {job.recovery.diagnostic.artifacts.length > 0 && (
            <ul className="mt-4 space-y-2 text-xs text-muted">
              {job.recovery.diagnostic.artifacts.map((artifact, index) => (
                <li key={`${artifact.kind}-${index}`} className="break-all rounded-md bg-surface-hover/60 p-3">
                  {artifact.kind}: {artifact.state}, {artifact.format}{artifact.path ? `, ${artifact.path}` : ""}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {job.text && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Output</h2>
          <div className="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.text}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return <div><dt className="font-semibold text-faint">{label}</dt><dd className="mt-0.5 break-all text-muted">{value}</dd></div>;
}
