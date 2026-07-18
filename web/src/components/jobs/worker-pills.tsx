"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, History, Layers3 } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { WorkerCard, pillTone, TONE } from "@/components/jobs/worker-card";
import { cn } from "@/lib/cn";

// Back-compat re-exports (app/jobs/page.tsx imports pillTone from here).
export { pillTone, TONE };

// Collapsed "worker" pills in the sidebar — each the shared <WorkerCard> wrapped
// in a Link to its detail. Same component the assistant chat renders inline.
export function WorkerPills() {
  const { jobs, removeJob, clearFinished } = useJobs();
  const pathname = usePathname();
  const visible = jobs.filter((job) => job.status === "running" || !job.acknowledgedAt);
  if (visible.length === 0) return null;
  const running = visible.filter((j) => j.status === "running").length;
  const finished = visible.length - running;
  const grouped = new Map<string, typeof visible>();
  const individual = visible.filter((job) => {
    if (!job.batchId) return true;
    grouped.set(job.batchId, [...(grouped.get(job.batchId) ?? []), job]);
    return false;
  });

  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">Workers</span>
        {running > 0 && <span className="text-[10px] tabular-nums text-brand">{running} running</span>}
        <Link href="/jobs" className="ml-auto text-faint transition-colors hover:text-foreground" title="History" aria-label="Worker history">
          <History className="size-3.5" />
        </Link>
        {finished > 0 && (
          <button onClick={clearFinished} className="text-[10px] text-faint transition-colors hover:text-foreground" title="Clear finished">
            clear
          </button>
        )}
      </div>
      <ul className="space-y-1.5">
        {[...grouped.entries()].slice(0, 3).map(([groupId, children]) => {
          const active = pathname === `/jobs/groups/${groupId}`;
          const groupRunning = children.filter((child) => child.status === "running").length;
          return <li key={groupId}><Link href={`/jobs/groups/${groupId}`} className={cn("block rounded-lg border px-2.5 py-2 transition-colors", active ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/60 hover:bg-surface-hover")}><div className="flex items-center gap-2"><Layers3 className="size-3.5 shrink-0 text-brand" /><span className="truncate text-xs font-medium">Grouped work</span><span className="ml-auto text-[9px] font-semibold uppercase tracking-wide text-muted">{groupRunning ? `${groupRunning} running` : `${children.length} outcomes`}</span></div><p className="mt-1 truncate text-[10px] text-faint">{children.map((child) => child.title).join(", ")}</p></Link></li>;
        })}
        {individual.slice(0, Math.max(0, 6 - grouped.size)).map((j) => {
          const active = pathname === `/jobs/${j.id}`;
          return (
            <li key={j.id}>
              <Link
                href={`/jobs/${j.id}`}
                className={cn(
                  "group block rounded-lg border px-2.5 py-2 transition-colors",
                  active ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/60 hover:bg-surface-hover",
                )}
              >
                <WorkerCard
                  job={j}
                  variant="tray"
                  trailing={
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        removeJob(j.id);
                      }}
                      className="text-faint opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      aria-label="Acknowledge worker outcome"
                    >
                      <X className="size-3" />
                    </button>
                  }
                />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
