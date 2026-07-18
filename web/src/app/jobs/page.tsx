"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, AlertTriangle, Loader2, CheckCheck } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { pillTone } from "@/components/jobs/worker-pills";
import { cn } from "@/lib/cn";
import { GROUP_CHILD_OUTCOMES, type ProjectedWorkGroup } from "@/lib/core/work-group";

const TONE_CHIP = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/15 text-red-700 dark:text-red-400",
  muted: "bg-surface-hover text-muted",
} as const;

export default function JobsHistory() {
  const { jobs, clearFinished } = useJobs();
  const [groups, setGroups] = useState<ProjectedWorkGroup[]>([]);
  const refreshGroups = useCallback(async () => {
    try {
      const response = await fetch("/api/work-groups", { cache: "no-store" });
      if (response.ok) setGroups(((await response.json()).groups ?? []) as ProjectedWorkGroup[]);
    } catch {
      /* Durable group history remains available on disk. */
    }
  }, []);
  useEffect(() => {
    void refreshGroups();
    window.addEventListener("co-job-done", refreshGroups);
    window.addEventListener("co-worker-settled", refreshGroups);
    return () => {
      window.removeEventListener("co-job-done", refreshGroups);
      window.removeEventListener("co-worker-settled", refreshGroups);
    };
  }, [refreshGroups]);
  const groupedWorkers = useMemo(() => new Set(groups.flatMap((group) => group.children.map((child) => child.workerId))), [groups]);
  const ungroupedJobs = jobs.filter((job) => !groupedWorkers.has(job.id));

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Workers</h1>
          <p className="mt-1 text-sm text-muted">
            Canonical groups and individual workers remain available after processing. <span className="tabular-nums">{groups.length + ungroupedJobs.length}</span> total.
          </p>
        </div>
        {jobs.some((j) => j.status !== "running") && (
          <button
            onClick={clearFinished}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <CheckCheck className="size-3.5" /> Acknowledge finished
          </button>
        )}
      </div>

      {groups.length === 0 && ungroupedJobs.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
          No workers yet. Hit <span className="text-foreground">Evaluate</span> on an inbox posting to spin one up.
        </div>
      ) : (
        <>
          {groups.length > 0 && (
            <section className="mt-6" aria-labelledby="work-groups-title">
              <h2 id="work-groups-title" className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Grouped work</h2>
              <ul className="mt-3 space-y-3">
                {groups.map((group) => (
                  <li key={group.id}>
                    <Link href={`/jobs/groups/${group.id}`} className="block rounded-2xl border border-border bg-surface/40 p-4 transition-colors hover:bg-surface-hover">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold">{group.title}</div>
                          <div className="mt-1 text-xs text-muted">{group.children.length} canonical child record{group.children.length === 1 ? "" : "s"}</div>
                        </div>
                        {group.attentionCount > 0 && <span className="rounded-md bg-amber-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">{group.attentionCount} need attention</span>}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2" aria-label="Group outcome summary">
                        {GROUP_CHILD_OUTCOMES.filter((outcome) => group.summary[outcome] > 0).map((outcome) => (
                          <span key={outcome} className="rounded-md border border-border bg-background/40 px-2 py-1 text-[10px] font-medium capitalize text-muted">{outcome} {group.summary[outcome]}</span>
                        ))}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {ungroupedJobs.length > 0 && <h2 className="mt-8 text-xs font-semibold uppercase tracking-[0.18em] text-muted">Individual workers</h2>}
          {ungroupedJobs.length > 0 && <ul className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
          {ungroupedJobs.map((j) => {
            const tone = pillTone(j);
            return (
              <li key={j.id}>
                <Link href={`/jobs/${j.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover">
                  {j.status === "running" ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-brand" />
                  ) : j.status === "error" ? (
                    <AlertTriangle className="size-4 shrink-0 text-red-400" />
                  ) : (
                    <Check className="size-4 shrink-0 text-emerald-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{j.title}</div>
                    {(j.recovery?.message || j.subtitle || j.result?.summary) && (
                      <div className="truncate text-xs text-muted">{j.recovery?.message || j.result?.summary || j.subtitle}</div>
                    )}
                  </div>
                  {j.result?.score != null && (
                    <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", TONE_CHIP[tone])}>
                      {j.result.score}/5
                    </span>
                  )}
                  <span className="hidden shrink-0 text-xs capitalize text-faint sm:block">{j.recovery?.outcome ?? j.status}</span>
                </Link>
              </li>
            );
          })}
          </ul>}
        </>
      )}
    </div>
  );
}
