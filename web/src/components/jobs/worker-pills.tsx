"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X, History } from "lucide-react";
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
        {visible.slice(0, 6).map((j) => {
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
