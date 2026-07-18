"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Search, Sparkles, UsersRound, X } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import type { OpportunitySummary } from "@/lib/core/opportunity-lifecycle";
import { cn } from "@/lib/cn";

type Command = "set-primary" | "release-primary" | "generate-once";

function words(value: string | null): string {
  if (!value) return "";
  return value.replaceAll("-", " ").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function commandCopy(command: Command, opportunity: OpportunitySummary) {
  if (command === "set-primary") return {
    title: `Make Opportunity #${opportunity.opportunity} Primary?`,
    detail: "This changes durable candidacy coordination for the shared Hiring surface. Sibling generation eligibility may change, but every factual Stage stays unchanged.",
    confirm: "Confirm Primary change",
  };
  if (command === "release-primary") return {
    title: `Release Opportunity #${opportunity.opportunity} as Primary?`,
    detail: "This removes the durable reservation. The canonical selector will recommend the current best lead again. Every factual Stage and the Outreach anchor stay unchanged.",
    confirm: "Confirm release",
  };
  return {
    title: `Generate once for Opportunity #${opportunity.opportunity}?`,
    detail: "This authorizes one interactive generation request for this Opportunity. It does not change the standing Primary, create a reusable override, or change any factual Stage.",
    confirm: "Generate once",
  };
}

export function CandidacyCoordination({ opportunity }: { opportunity: OpportunitySummary }) {
  const candidacy = opportunity.candidacy;
  const router = useRouter();
  const { startJob } = useJobs();
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!command) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setCommand(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [command, busy]);

  function closeReview() {
    if (busy) return;
    setCommand(null);
    setTimeout(() => triggerRef.current?.focus(), 0);
  }

  function review(next: Command, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setError(null);
    setNotice(null);
    setCommand(next);
  }

  async function confirm() {
    if (!command || !opportunity.stage.id) return;
    setBusy(true);
    setError(null);
    try {
      if (command === "generate-once") {
        const job = startJob({
          title: `Prepare Opportunity #${opportunity.opportunity}`,
          subtitle: `${opportunity.company} · ${opportunity.role}`,
          kind: "lifecycle",
          input: JSON.stringify({
            opportunity: opportunity.opportunity,
            expectedStage: opportunity.stage.id,
            expectedRevision: opportunity.revision,
            candidacyOverride: true,
          }),
          page: `/pipeline/${opportunity.opportunity}`,
        });
        if (!job) throw new Error("The one-generation worker could not be started.");
        setNotice(`Starting one authorized generation for Opportunity #${opportunity.opportunity}.`);
        setCommand(null);
        return;
      }
      const response = await fetch(`/api/opportunities/${opportunity.opportunity}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: command,
          expectedStage: opportunity.stage.id,
          expectedRevision: opportunity.revision,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.effect === "blocked" || result.effect === "unavailable" || result.effect === "conflict") {
        throw new Error(result.message ?? result.error?.message ?? "The candidacy command could not be completed.");
      }
      setNotice(result.message);
      setCommand(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The candidacy command could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  if (candidacy.state === "research-required") {
    const invalidIssues = candidacy.research?.invalidClusters.flatMap((cluster) => (
      Array.isArray(cluster.issues) ? cluster.issues.filter((issue): issue is string => typeof issue === "string") : []
    )) ?? [];
    const prompt = `Research the current Hiring surfaces for ${opportunity.company} Opportunities ${candidacy.research?.applications.map((item) => `#${item}`).join(", ")}. Follow modes/next.md Candidacy Coordination, update the canonical registry only after evidence is clear, then rerun candidacy-select.mjs.`;
    return (
      <section aria-labelledby="candidacy-heading" className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-300" aria-hidden="true" />
          <h2 id="candidacy-heading" className="text-sm font-semibold">Hiring-surface research required</h2>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Primary selection and one-generation exceptions are blocked until the canonical evidence is refreshed and the selector reruns.
        </p>
        <dl className="mt-3 space-y-2 text-xs">
          <Row label="Reason" value={words(candidacy.research?.reason ?? candidacy.reason)} />
          {candidacy.research?.unclassified.length ? <Row label="Unclassified" value={candidacy.research.unclassified.map((item) => `#${item}`).join(", ")} /> : null}
          {candidacy.research?.multiplyClassified.length ? <Row label="Drift" value={candidacy.research.multiplyClassified.map((item) => `#${item}`).join(", ")} /> : null}
          {invalidIssues.length ? <Row label="Evidence issues" value={invalidIssues.join(", ")} /> : null}
        </dl>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("co-assistant", { detail: { message: prompt } }))}
          className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand px-3 text-xs font-semibold text-brand-foreground hover:bg-brand-200"
        >
          <Search className="size-4" aria-hidden="true" /> Research and rerun
        </button>
      </section>
    );
  }

  if (!candidacy.shared) return null;
  const copy = command ? commandCopy(command, opportunity) : null;
  const predictedSelection = (member: OpportunitySummary["candidacy"]["members"][number]) => {
    if (command === "generate-once") return member.selection;
    const nextLead = command === "set-primary" ? opportunity.opportunity : candidacy.recommendedLead;
    if (member.owner !== "agent") return member.selection;
    return member.opportunity === nextLead ? "eligible" : "suppressed";
  };
  return (
    <>
      <section aria-labelledby="candidacy-heading" className="mt-4 rounded-2xl border border-border bg-surface/55 p-4">
        <div className="flex items-center gap-2">
          <UsersRound className="size-4 text-brand" aria-hidden="true" />
          <h2 id="candidacy-heading" className="text-sm font-semibold">Shared Hiring surface</h2>
        </div>
        <dl className="mt-3 space-y-2 text-xs">
          <Row label="Reason" value={candidacy.surface || "Shared surface confirmed"} />
          {candidacy.confidence && <Row label="Confidence" value={words(candidacy.confidence)} />}
          <Row label="Recommended lead" value={candidacy.recommendedLead ? `Opportunity #${candidacy.recommendedLead}` : "None"} recommendation />
          <Row label="Persisted Primary" value={candidacy.persistedPrimary ? `Opportunity #${candidacy.persistedPrimary}` : "Not selected"} />
          <Row label="Outreach anchor" value={candidacy.outreachAnchor ? `Opportunity #${candidacy.outreachAnchor}` : "Not established"} />
          {candidacy.evidence && <Row label="Evidence" value={candidacy.evidence} />}
          {candidacy.reviewed && <Row label="Reviewed" value={candidacy.reviewed} />}
        </dl>
        <ul className="mt-4 space-y-2" aria-label="Hiring surface members">
          {candidacy.members.map((member) => (
            <li key={member.opportunity} className="rounded-lg border border-border bg-background/45 p-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium">#{member.opportunity} {member.role}</span>
                <span className={cn("shrink-0 text-[10px] font-semibold uppercase tracking-wide", member.selection === "suppressed" ? "text-amber-700 dark:text-amber-300" : "text-faint")}>{words(member.selection)}</span>
              </div>
              <p className="mt-1 text-[10px] text-faint">Stage: {member.stageLabel}{member.reason ? ` · ${words(member.reason)}` : ""}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 grid gap-2">
          {candidacy.canSelectPrimary && (
            <button type="button" onClick={(event) => review("set-primary", event.currentTarget)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand px-3 text-xs font-semibold text-brand-foreground hover:bg-brand-200">
              <CheckCircle2 className="size-4" aria-hidden="true" /> Make this Primary
            </button>
          )}
          {candidacy.canReleasePrimary && (
            <button type="button" onClick={(event) => review("release-primary", event.currentTarget)} className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-3 text-xs font-semibold hover:bg-surface-hover">
              Release Primary
            </button>
          )}
          {candidacy.canGenerateOnce && (
            <button type="button" onClick={(event) => review("generate-once", event.currentTarget)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-brand/35 bg-brand-soft px-3 text-xs font-semibold text-brand-text hover:bg-brand/15">
              <Sparkles className="size-4" aria-hidden="true" /> Generate once
            </button>
          )}
        </div>
        {notice && <p role="status" className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      </section>

      {command && copy && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeReview(); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="candidacy-review-title" className="w-full max-w-lg rounded-2xl border border-border bg-background p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand-text">Consequence review</p>
                <h2 id="candidacy-review-title" className="mt-1 font-display text-2xl text-landing">{copy.title}</h2>
              </div>
              <button type="button" onClick={closeReview} disabled={busy} aria-label="Close candidacy review" className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-surface-hover disabled:opacity-50"><X className="size-4" /></button>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted">{copy.detail}</p>
            <div className="mt-4 rounded-xl border border-border bg-surface/40 p-4 text-xs">
              <p><strong>Outreach anchor:</strong> {candidacy.outreachAnchor ? `#${candidacy.outreachAnchor}, preserved` : "none"}</p>
              <div className="mt-3">
                <strong>Eligibility consequences:</strong>
                <ul className="mt-2 space-y-1.5">
                  {candidacy.members.map((member) => (
                    <li key={member.opportunity}>
                      #{member.opportunity} {words(member.selection)} → {words(predictedSelection(member))}; Stage stays {member.stageLabel}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="mt-2"><strong>Stage effect:</strong> no factual Stage changes</p>
            </div>
            {error && <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-300">{error}</p>}
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={closeReview} disabled={busy} className="min-h-11 rounded-md border border-border px-4 text-sm font-medium hover:bg-surface-hover disabled:opacity-50">Cancel</button>
              <button ref={confirmRef} type="button" onClick={confirm} disabled={busy} className="min-h-11 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground hover:bg-brand-200 disabled:opacity-50">{busy ? "Checking fresh state…" : copy.confirm}</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Row({ label, value, recommendation = false }: { label: string; value: string; recommendation?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-faint">{label}</dt>
      <dd className="max-w-[65%] break-words text-right font-medium text-foreground">
        {recommendation && <Sparkles className="mr-1 inline size-3 text-brand" aria-label="Recommendation" />}{value}
      </dd>
    </div>
  );
}
