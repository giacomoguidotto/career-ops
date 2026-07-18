"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { scoreTone } from "@/lib/format";
import type { LifecycleWorkOrder } from "@/lib/core/opportunity-lifecycle";
import type { WorkRecovery, WorkRecoveryTrigger } from "@/lib/core/work-recovery";
import type { DurableWorker } from "@/lib/core/worker-store";

export type JobStep = { kind: "tool" | "status"; label: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };

export type Job = {
  id: string;
  title: string;
  subtitle?: string;
  page?: string; // route the job was launched from / refers to
  input?: string; // the URL/posting it processed (links inbox rows to their worker)
  kind?: string;
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  status: "running" | "done" | "error";
  steps: JobStep[];
  text: string;
  result?: JobResult;
  cost?: { tokens: number; usd?: number }; // per-run token cost (Claude result event) — local only
  workOrder?: LifecycleWorkOrder;
  recovery?: WorkRecovery;
  recoveryHistory?: WorkRecovery[];
  acknowledgedAt?: number;
  startedAt: number;
  endedAt?: number;
};

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string };

type Ctx = {
  jobs: Job[];
  startJob: (opts: StartOpts) => string | null;
  actOnJob: (id: string) => void;
  acknowledgeJob: (id: string) => void;
  removeJob: (id: string) => void;
  clearFinished: () => void;
};

const JobsContext = createContext<Ctx | null>(null);
export function useJobs() {
  const c = useContext(JobsContext);
  if (!c) throw new Error("useJobs must be used within <JobsProvider>");
  return c;
}

const CONFIG_KEY = "career-ops:config";
const JOBS_KEY = "career-ops:jobs";

function parseVerdict(text: string): JobResult {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

function recoveryStatus(recovery: WorkRecovery): Job["status"] {
  return ["changed", "recovered", "unchanged"].includes(recovery.outcome) ? "done" : "error";
}

function durableJob(worker: DurableWorker, local?: Job): Job {
  const recovery = worker.recoveryHistory.at(-1);
  return {
    id: worker.id,
    title: local?.title ?? worker.title,
    subtitle: local?.subtitle ?? worker.subtitle ?? undefined,
    page: local?.page ?? worker.page ?? undefined,
    input: local?.input ?? JSON.stringify({
      opportunity: worker.workOrder.opportunity,
      expectedStage: worker.workOrder.source.stage,
      expectedRevision: worker.workOrder.source.revision,
    }),
    kind: "lifecycle",
    batchId: local?.batchId ?? worker.batchId ?? undefined,
    status: worker.status === "active" ? "running" : recovery ? recoveryStatus(recovery) : "error",
    steps: worker.phases.map((item) => ({ kind: "status", label: item.label, ts: Date.parse(item.at) })),
    text: local?.text ?? "",
    result: local?.result,
    cost: local?.cost,
    workOrder: worker.workOrder,
    recovery,
    recoveryHistory: worker.recoveryHistory,
    acknowledgedAt: worker.acknowledgedAt ? Date.parse(worker.acknowledgedAt) : undefined,
    startedAt: Date.parse(worker.startedAt),
    endedAt: worker.endedAt ? Date.parse(worker.endedAt) : undefined,
  };
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const seq = useRef(0);
  const loaded = useRef(false);

  const patch = useCallback((id: string, fn: (j: Job) => Job) => {
    setJobs((js) => js.map((j) => (j.id === id ? fn(j) : j)));
  }, []);

  const applyRecovery = useCallback((id: string, recovery: WorkRecovery, cost?: Job["cost"]) => {
    patch(id, (job) => ({
      ...job,
      status: recoveryStatus(recovery),
      recovery,
      recoveryHistory: [...(job.recoveryHistory ?? []), recovery],
      cost: cost ?? job.cost,
      endedAt: Date.parse(recovery.occurredAt),
      steps: [...job.steps, { kind: "status", label: recovery.message, ts: Date.parse(recovery.occurredAt) }],
    }));
    setAnnouncement(recovery.message);
    if (["changed", "recovered", "unchanged"].includes(recovery.outcome)) {
      window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "lifecycle" } }));
    }
  }, [patch]);

  const recoverJob = useCallback(async (id: string, trigger: WorkRecoveryTrigger, polls = 0): Promise<void> => {
    try {
      const response = await fetch(`/api/workers/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recover", trigger }),
      });
      const value = await response.json();
      if (response.status === 202 && value.active && polls < 20) {
        window.setTimeout(() => void recoverJob(id, trigger, polls + 1), 250);
        return;
      }
      if (response.ok && value.recovery) {
        applyRecovery(id, value.recovery as WorkRecovery);
        return;
      }
      patch(id, (job) => ({
        ...job,
        status: "error",
        endedAt: Date.now(),
        steps: [...job.steps, { kind: "status", label: "Recovery evidence is unavailable", ts: Date.now() }],
      }));
      setAnnouncement("Recovery evidence is unavailable.");
    } catch {
      patch(id, (job) => ({
        ...job,
        status: "error",
        endedAt: Date.now(),
        steps: [...job.steps, { kind: "status", label: "Recovery inspection could not complete", ts: Date.now() }],
      }));
      setAnnouncement("Recovery inspection could not complete.");
    }
  }, [applyRecovery, patch]);

  // Restore client presentation, then merge the durable canonical worker records.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let local: Job[] = [];
      try {
        const raw = localStorage.getItem(JOBS_KEY);
        const value = raw ? JSON.parse(raw) : null;
        if (Array.isArray(value)) local = value;
      } catch {
        /* presentation cache is optional */
      }
      try {
        const response = await fetch("/api/workers", { cache: "no-store" });
        const value = response.ok ? await response.json() : { workers: [] };
        const byId = new Map(local.map((job) => [job.id, job]));
        for (const worker of (value.workers ?? []) as DurableWorker[]) {
          byId.set(worker.id, durableJob(worker, byId.get(worker.id)));
        }
        local = [...byId.values()].sort((left, right) => right.startedAt - left.startedAt);
      } catch {
        /* durable history remains on disk and can be loaded later */
      }
      if (cancelled) return;
      setJobs(local);
      loaded.current = true;
      for (const job of local) {
        if (job.kind === "lifecycle" && job.status === "running") void recoverJob(job.id, "reload");
      }
    })();
    return () => { cancelled = true; };
  }, [recoverJob]);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(jobs.slice(0, 100)));
    } catch {
      /* quota */
    }
  }, [jobs]);

  const execute = useCallback((id: string, opts: StartOpts, cliId: string, resume: boolean) => {
    void (async () => {
      let text = "";
      let verdictLine = "";
      let doneTokens = 0;
      let doneCostUsd: number | null = null;
      let sawTerminal = false;
      const steps: JobStep[] = [];
      const finish = (status: "done" | "error", lastLabel?: string) => {
        const result = status === "done" ? parseVerdict(verdictLine || text) : undefined;
        const cost = status === "done" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
        patch(id, (job) => ({
          ...job,
          status,
          result,
          cost,
          endedAt: Date.now(),
          steps: lastLabel ? [...job.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : job.steps,
        }));
        if (status === "done") {
          fetch("/api/runs/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, result, cost, steps, output: text }),
          }).catch(() => {});
          if (["evaluate", "pdf"].includes(opts.kind)) {
            window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
          }
        }
      };

      try {
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: opts.kind,
            input: opts.input,
            cliId,
            workerId: id,
            resume,
            title: opts.title,
            subtitle: opts.subtitle,
            page: opts.page,
            batchId: opts.batchId,
          }),
        });
        if (!response.ok || !response.body) {
          const error = await response.json().catch(() => ({}));
          finish("error", error.error || "Failed to start");
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              const event = JSON.parse(line);
              if (event.type === "identity") {
                patch(id, (job) => ({
                  ...job,
                  workOrder: event.workOrder,
                  steps: [...job.steps, { kind: "status", label: event.label, ts: Date.now() }],
                }));
              } else if (event.type === "tool") {
                steps.push({ kind: "tool", label: event.name, ts: Date.now() });
                patch(id, (job) => ({ ...job, steps: [...job.steps, { kind: "tool", label: event.name, ts: Date.now() }] }));
              } else if (event.type === "status") {
                steps.push({ kind: "status", label: event.label, ts: Date.now() });
                patch(id, (job) => ({ ...job, steps: [...job.steps, { kind: "status", label: event.label, ts: Date.now() }] }));
              } else if (event.type === "text") {
                const full = text + event.text;
                const match = full.match(/VERDICT:[^\n]*/i);
                if (match) verdictLine = match[0];
                text = full.slice(-8000);
                patch(id, (job) => ({ ...job, text }));
              } else if (event.type === "done") {
                if (typeof event.tokens === "number") doneTokens = event.tokens;
                if (typeof event.costUsd === "number") doneCostUsd = event.costUsd;
              } else if (event.type === "terminal") {
                sawTerminal = true;
                const cost = typeof event.tokens === "number" && event.tokens > 0
                  ? { tokens: event.tokens, usd: typeof event.costUsd === "number" ? event.costUsd : undefined }
                  : undefined;
                applyRecovery(id, event.recovery as WorkRecovery, cost);
              } else if (event.type === "error") {
                finish("error", event.msg || "Error");
                return;
              }
            } catch {
              /* skip malformed transport lines */
            }
          }
        }
        if (opts.kind === "lifecycle") {
          if (!sawTerminal) await recoverJob(id, "uncertain-close");
        } else {
          finish("done", "Done");
        }
      } catch {
        if (opts.kind === "lifecycle") await recoverJob(id, "disconnect");
        else finish("error", "Connection error");
      }
    })();
  }, [applyRecovery, patch, recoverJob]);

  const startJob = useCallback(
    (opts: StartOpts): string | null => {
      let cliId: string | null = null;
      try {
        const raw = localStorage.getItem(CONFIG_KEY);
        cliId = raw ? JSON.parse(raw).cliId || null : null;
      } catch {
        cliId = null;
      }
      const id = `job-${Date.now()}-${seq.current++}`;
      const job: Job = {
        id,
        title: opts.title,
        subtitle: opts.subtitle,
        page: opts.page,
        input: opts.input,
        kind: opts.kind,
        batchId: opts.batchId,
        status: "running",
        steps: [{ kind: "status", label: "Starting…", ts: Date.now() }],
        text: "",
        startedAt: Date.now(),
      };
      setJobs((js) => [job, ...js]);

      if (!cliId) {
        patch(id, (j) => ({ ...j, status: "error", endedAt: Date.now(), steps: [...j.steps, { kind: "status", label: "No CLI configured: open Config", ts: Date.now() }] }));
        return id;
      }
      execute(id, opts, cliId, false);

      return id;
    },
    [execute, patch],
  );

  const actOnJob = useCallback((id: string) => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job || job.status === "running" || !job.recovery || !["retry", "resume"].includes(job.recovery.nextAction.kind)) return;
    let cliId: string | null = null;
    try {
      cliId = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}").cliId || null;
    } catch {
      cliId = null;
    }
    if (!cliId) {
      patch(id, (current) => ({ ...current, steps: [...current.steps, { kind: "status", label: "No CLI configured: open Config", ts: Date.now() }] }));
      return;
    }
    const opts: StartOpts = {
      title: job.title,
      subtitle: job.subtitle,
      kind: job.kind || "lifecycle",
      input: job.input || "",
      page: job.page,
      batchId: job.batchId,
    };
    patch(id, (current) => ({
      ...current,
      status: "running",
      endedAt: undefined,
      acknowledgedAt: undefined,
      steps: [...current.steps, { kind: "status", label: "Resuming preserved work", ts: Date.now() }],
    }));
    execute(id, opts, cliId, true);
  }, [execute, jobs, patch]);

  const acknowledgeJob = useCallback((id: string) => {
    const at = Date.now();
    patch(id, (job) => job.status === "running" ? job : { ...job, acknowledgedAt: at });
    fetch(`/api/workers/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "acknowledge" }),
    }).catch(() => {});
  }, [patch]);
  const removeJob = acknowledgeJob;
  const clearFinished = useCallback(() => {
    for (const job of jobs) if (job.status !== "running" && !job.acknowledgedAt) acknowledgeJob(job.id);
  }, [acknowledgeJob, jobs]);

  return (
    <JobsContext.Provider value={{ jobs, startJob, actOnJob, acknowledgeJob, removeJob, clearFinished }}>
      {children}
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
    </JobsContext.Provider>
  );
}
