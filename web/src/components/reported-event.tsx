"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
  ApproachAttempt,
  LifecycleContract,
  LifecycleCommandOutcome,
  OpportunitySummary,
} from "@/lib/core/opportunity-lifecycle";
import { reportableSuccessors } from "@/lib/core/reported-event-contract";
import type {
  ReportRouteContext,
  ReportedAttemptProposal,
  ReportedEventInterpretation,
  ReportedEventProposal,
} from "@/lib/core/reported-event";

const ATTEMPT_TYPES = [
  "formal_application",
  "founder_outreach",
  "recruiter_outreach",
  "hiring_manager_outreach",
  "peer_outreach",
  "referral_request",
  "qualifying_question",
  "personalized_media",
  "in_person",
  "follow_up",
  "other",
];

function words(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cliId() {
  try { return JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId || ""; }
  catch { return ""; }
}

type CheckpointProps = {
  opportunity: OpportunitySummary;
  contract: LifecycleContract;
  attempts: ApproachAttempt[];
  route?: ReportRouteContext | null;
  onBack?: () => void;
  onRecorded?: () => void;
};

export function ReportedEventCheckpoint({ opportunity: initial, contract, attempts, route = null, onBack, onRecorded }: CheckpointProps) {
  const [context, setContext] = useState(initial);
  const [report, setReport] = useState("");
  const [interpretation, setInterpretation] = useState<ReportedEventInterpretation | null>(null);
  const [busy, setBusy] = useState<"interpret" | "confirm" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<LifecycleCommandOutcome | null>(null);
  const proposal = interpretation?.kind === "proposal" ? interpretation.proposal : null;

  async function interpret() {
    if (!report.trim()) return;
    const selectedCli = cliId();
    if (!selectedCli) {
      setNotice("Choose an installed CLI in Settings before interpreting the report.");
      return;
    }
    setBusy("interpret");
    setNotice(null);
    setInterpretation(null);
    try {
      const response = await fetch(`/api/opportunities/${context.opportunity}/reported-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "interpret",
          cliId: selectedCli,
          expectedStage: context.stage.id,
          expectedRevision: context.revision,
          report,
          route,
        }),
      });
      const body = await response.json();
      if (response.status === 409 && body.after) {
        setContext(body.after);
        setNotice("The Opportunity changed. Fresh context is loaded; interpret the report again.");
        return;
      }
      if (!response.ok) throw new Error(body.error?.message || "Interpretation failed.");
      setContext(body.opportunity);
      setInterpretation(body.interpretation);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Interpretation failed.");
    } finally {
      setBusy(null);
    }
  }

  function updateProposal(next: ReportedEventProposal) {
    setInterpretation({ kind: "proposal", proposal: next });
  }

  async function confirm() {
    if (!proposal) return;
    setBusy("confirm");
    setNotice(null);
    try {
      const response = await fetch(`/api/opportunities/${context.opportunity}/reported-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          expectedStage: context.stage.id,
          expectedRevision: context.revision,
          proposal,
        }),
      });
      const body = await response.json();
      if (response.status === 409 && body.after) {
        setContext(body.after);
        setInterpretation(null);
        setNotice("The Opportunity changed. Nothing was written. Review the fresh context and interpret again.");
        return;
      }
      if (body.effect === "blocked" || body.effect === "unavailable") {
        setNotice(body.message);
        if (body.after) setContext(body.after);
        return;
      }
      if (!response.ok || !body.effect) throw new Error(body.error?.message || body.message || "Confirmation failed.");
      setRecorded(body);
      if (body.after) setContext(body.after);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Confirmation failed.");
    } finally {
      setBusy(null);
    }
  }

  if (recorded) {
    return (
      <div data-reported-event="recorded">
        <Heading eyebrow="Confirmed canonical fact" title="Added to history" body={recorded.message} />
        <div className="mt-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-5">
          <CheckCircle2 className="size-6 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
          <p className="mt-3 font-semibold">The explicit confirmation crossed the write boundary.</p>
          <p className="mt-2 text-sm text-muted">The page can now reload the canonical Stage and append-only history.</p>
        </div>
        <div className="mt-7 flex justify-end border-t border-border pt-5">
          <Button type="button" className="min-h-11" onClick={() => onRecorded?.()}>Reload canonical history</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Heading eyebrow="Report checkpoint · Read only" title="What happened?" body="Describe the real-world event in your own words. The interpreter may propose one typed update or ask one focused question. It cannot write." />
      <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div>
          <label htmlFor="reported-event-text" className="text-sm font-semibold">Natural-language report</label>
          <p className="mt-1 text-xs leading-relaxed text-muted">Include what happened, the channel, who was involved, when it happened, and the result.</p>
          <textarea
            id="reported-event-text"
            value={report}
            onChange={(event) => { setReport(event.target.value); setInterpretation(null); setNotice(null); }}
            placeholder="For example: I sent Elena the follow-up by email this morning. No reply yet."
            className="mt-3 min-h-44 w-full resize-y rounded-2xl border border-border bg-background/55 p-4 text-base leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          />
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] text-faint">Live Stage, revision, selected route, and Attempt history are supplied as read-only context.</p>
            <Button type="button" disabled={!report.trim() || busy !== null} onClick={interpret} className="min-h-11 gap-2">
              {busy === "interpret" ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Sparkles className="size-4" />}
              {busy === "interpret" ? "Interpreting" : "Interpret report"}
            </Button>
          </div>
          {notice && <div role="status" className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted"><AlertTriangle className="mr-2 inline size-4 text-amber-700 dark:text-amber-300" />{notice}</div>}
        </div>

        <aside className="rounded-2xl border border-border bg-background/35 p-5" aria-live="polite">
          {!interpretation && !busy && <Idle route={route} />}
          {busy === "interpret" && <Working />}
          {interpretation?.kind === "clarification" && (
            <div data-interpretation="clarification">
              <AlertTriangle className="size-5 text-amber-700 dark:text-amber-300" />
              <p className="mt-3 font-display text-2xl text-landing">One detail is missing</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{interpretation.question}</p>
              <p className="mt-4 font-mono text-[10px] uppercase tracking-wide text-faint">No update prepared</p>
            </div>
          )}
          {proposal && (
            <ProposalEditor proposal={proposal} opportunity={context} contract={contract} attempts={attempts} onChange={updateProposal} />
          )}
        </aside>
      </div>
      <div className="mt-7 flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-start sm:justify-between">
        {onBack ? <Button type="button" variant="outline" onClick={onBack} className="min-h-11 gap-2"><ArrowLeft className="size-4" /> Back</Button> : <span />}
        <div className="sm:text-right">
          <Button type="button" disabled={!proposal || busy !== null} onClick={confirm} className="min-h-11 gap-2">
            {busy === "confirm" ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <LockKeyhole className="size-4" />}
            {busy === "confirm" ? "Confirming" : "Confirm and add to history"}
          </Button>
          <p className="mt-2 text-[11px] text-faint">This is the only control that can record the typed proposal.</p>
        </div>
      </div>
    </div>
  );
}

function ProposalEditor({ proposal, opportunity, contract, attempts, onChange }: { proposal: ReportedEventProposal; opportunity: OpportunitySummary; contract: LifecycleContract; attempts: ApproachAttempt[]; onChange: (proposal: ReportedEventProposal) => void }) {
  const updateAttempt = (field: keyof ReportedAttemptProposal, value: string | null) => {
    if (proposal.kind !== "attempt") return;
    onChange({
      ...proposal,
      [field]: value,
      ...(field === "type" && value !== "follow_up" ? { followUpTo: null } : {}),
    });
  };
  return (
    <div data-interpretation="proposal">
      <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-emerald-700 dark:text-emerald-300" /><p className="text-sm font-semibold">Typed proposal</p></div>
      <p className="mt-3 rounded-lg border border-dashed border-brand/40 bg-brand-soft/30 px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wide text-brand-text">Preview · Not recorded</p>
      {proposal.kind === "attempt" ? (
        <div className="mt-4 space-y-3">
          <SelectField label="Type" value={proposal.type} onChange={(value) => updateAttempt("type", value)} options={ATTEMPT_TYPES.map((type) => [type, words(type)])} />
          <TextField label="Channel" value={proposal.channel} onChange={(value) => updateAttempt("channel", value)} />
          <TextField label="Recipient" value={proposal.recipient} onChange={(value) => updateAttempt("recipient", value)} />
          <TextField label="Occurred at" value={proposal.occurredAt} onChange={(value) => updateAttempt("occurredAt", value)} hint="Date only means time unknown." />
          <TextField label="Result" value={proposal.result} onChange={(value) => updateAttempt("result", value)} />
          {proposal.type === "follow_up" && (
            <SelectField label="Follows Attempt" value={proposal.followUpTo ?? ""} onChange={(value) => updateAttempt("followUpTo", value || null)} options={attempts.map((attempt) => [attempt.id, `${attempt.id} · ${words(attempt.type)}`])} />
          )}
          <TextField label="Notes, optional" value={proposal.notes} onChange={(value) => updateAttempt("notes", value)} />
          <p className="text-[11px] leading-relaxed text-faint">Confirmation appends the Attempt before retry-safe repair to Approached. Existing Attempt rows stay unchanged.</p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <SelectField label="Allowed successor" value={proposal.successor} onChange={(successor) => onChange({ ...proposal, successor })} options={reportableSuccessors(opportunity, contract).map((id) => [id, words(id)])} />
          <TextField label="Occurred at" value={proposal.occurredAt} onChange={(occurredAt) => onChange({ ...proposal, occurredAt })} />
          <TextField label="Result" value={proposal.result} onChange={(result) => onChange({ ...proposal, result })} />
          <p className="text-[11px] leading-relaxed text-faint">Only a fresh successor declared by the canonical Stage can be confirmed. There is no free-form Stage field.</p>
        </div>
      )}
    </div>
  );
}

function Idle({ route }: { route: ReportRouteContext | null }) {
  return <div><MessageSquareText className="size-5 text-brand-text" /><p className="mt-3 font-display text-2xl text-landing">Structure before mutation</p><p className="mt-2 text-sm leading-relaxed text-muted">The interpreter returns a typed preview or a clarification. Copying, editing, revisiting, or dismissing the preview records nothing.</p>{route && <p className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted">Selected route: <strong className="text-foreground">{route.label}</strong></p>}</div>;
}

function Working() {
  return <div className="flex min-h-48 flex-col items-center justify-center text-center"><RefreshCw className="size-6 animate-spin text-brand-text motion-reduce:animate-none" /><p className="mt-4 text-sm font-semibold">Reading the live context</p><p className="mt-1 text-xs text-muted">No files can be changed by this worker.</p></div>;
}

function Heading({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return <div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-text">{eyebrow}</p><h3 className="mt-1 font-display text-3xl text-landing">{title}</h3><p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{body}</p></div>;
}

function TextField({ label, value, onChange, hint }: { label: string; value: string; onChange: (value: string) => void; hint?: string }) {
  return <label className="block text-[10px] font-semibold uppercase tracking-wide text-faint">{label}<input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm font-normal normal-case tracking-normal text-foreground" />{hint && <span className="mt-1 block font-normal normal-case tracking-normal">{hint}</span>}</label>;
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <label className="block text-[10px] font-semibold uppercase tracking-wide text-faint">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm font-normal normal-case tracking-normal text-foreground"><option value="">Select</option>{options.map(([option, name]) => <option key={option} value={option}>{name}</option>)}</select></label>;
}

export function ReportedEventLauncher({ opportunity, contract, attempts }: { opportunity: OpportunitySummary; contract: LifecycleContract; attempts: ApproachAttempt[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const available = opportunity.capabilities.recordAttempt || opportunity.capabilities.reportSuccessor;

  function close() {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, input, select') ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!available) return null;
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"><MessageSquareText className="size-4" /> Report real-world event</button>
      {open && (
        <div ref={dialogRef} className="fixed inset-0 z-[95] overflow-y-auto bg-background/98 p-4 backdrop-blur-sm sm:p-8" role="dialog" aria-modal="true" aria-label="Report real-world event">
          <div className="mx-auto max-w-5xl rounded-3xl border border-border bg-surface/80 p-5 shadow-xl sm:p-8">
            <div className="mb-5 flex justify-end"><button ref={closeRef} type="button" onClick={close} className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-surface-hover" aria-label="Close reported event"><X className="size-5" /></button></div>
            <ReportedEventCheckpoint opportunity={opportunity} contract={contract} attempts={attempts} onRecorded={() => window.location.reload()} />
          </div>
        </div>
      )}
    </>
  );
}
