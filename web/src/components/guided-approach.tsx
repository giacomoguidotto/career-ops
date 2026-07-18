"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Clipboard,
  ExternalLink,
  FileText,
  LockKeyhole,
  RefreshCw,
  Route as RouteIcon,
  ShieldCheck,
  X,
} from "lucide-react";
import { parseApproachPlan } from "@/lib/approach-plan.mjs";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

type RouteType = "outreach" | "application" | "qualifying" | "followup";
type AnswerState = "generated" | "user-edited" | "protected" | "blocked";
type Phase = "choose" | "prepare" | "act";

type PlanAnswer = {
  id: string;
  label: string;
  value: string;
  notes: string;
  instruction: string | null;
  limit: number | null;
  regenerationCandidates: string[];
  state: AnswerState;
};

type PlanRoute = {
  id: string;
  rank: number;
  type: RouteType;
  label: string;
  destination: string;
  channel: string;
  timing: string;
  whyFirst: string;
  instruction: string;
  body: string;
  limit: number | null;
  follows: string | null;
  answers: PlanAnswer[];
  blockedReason: string | null;
};

type AnswerDraft = PlanAnswer & {
  originalValue: string;
  proposal?: string | null;
  regenerationIndex: number;
  regenerationStatus?: "changed" | "proposed" | "unavailable";
};

const routeLabels: Record<RouteType, string> = {
  outreach: "Outreach",
  application: "Formal application",
  qualifying: "Qualifying",
  followup: "Follow-up",
};

function StatePill({ state }: { state: AnswerState }) {
  const label = state === "user-edited" ? "User edited" : state[0].toUpperCase() + state.slice(1);
  return (
    <span className={cn(
      "inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",
      state === "blocked" && "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
      state === "generated" && "border-border bg-surface text-muted",
      state === "user-edited" && "border-sky-500/40 bg-sky-500/10 text-sky-800 dark:text-sky-300",
      state === "protected" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
    )} data-answer-state={state}>
      {label}
    </span>
  );
}

export function GuidedApproach({ plan, opportunity }: { plan: string; opportunity: number }) {
  const routes = useMemo(() => parseApproachPlan(plan) as PlanRoute[], [plan]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }

  return (
    <div id="guided-approach" className="mt-5 scroll-mt-6">
      <button
        ref={triggerRef}
        type="button"
        disabled={routes.length === 0}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm hover:bg-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-45"
      >
        <RouteIcon className="size-4" aria-hidden="true" /> Start guided approach
      </button>
      <p className="mt-2 text-xs text-faint">
        Preparation only. Starting this guide cannot record an Attempt.
      </p>
      {routes.length === 0 && (
        <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted" role="status">
          The canonical Approach Plan has no ranked route that can be prepared here.
        </p>
      )}
      {open && <GuidedApproachDialog routes={routes} opportunity={opportunity} onClose={close} />}
    </div>
  );
}

function GuidedApproachDialog({ routes, opportunity, onClose }: { routes: PlanRoute[]; opportunity: number; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("choose");
  const [selectedId, setSelectedId] = useState(routes[0]?.id ?? "");
  const [draft, setDraft] = useState(routes[0]?.body ?? "");
  const [draftState, setDraftState] = useState<Exclude<AnswerState, "blocked">>("generated");
  const [answers, setAnswers] = useState<AnswerDraft[]>(() => answerDrafts(routes[0]));
  const [copyState, setCopyState] = useState<"idle" | "copied" | "denied">("idle");
  const [rerunNotice, setRerunNotice] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const selected = routes.find((route) => route.id === selectedId) ?? routes[0];

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) ?? first;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (!selected) return;
    setDraft(selected.body);
    setDraftState("generated");
    setAnswers(answerDrafts(selected));
    setCopyState("idle");
    setRerunNotice(false);
  }, [selected]);

  if (!selected) return null;
  const overLimit = selected.limit != null && draft.length > selected.limit;
  const invalidAnswers = selected.type === "application" && answers.some((answer) => answerBlocked(answer));
  const blocked = Boolean(selected.blockedReason) || overLimit || invalidAnswers;
  const steps: Array<{ id: Phase; label: string }> = [
    { id: "choose", label: "Choose" },
    { id: "prepare", label: "Prepare" },
    { id: "act", label: "Act outside" },
  ];
  const phaseIndex = steps.findIndex((step) => step.id === phase);

  async function copyDraft() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(draft);
      setCopyState("copied");
    } catch {
      setCopyState("denied");
    }
  }

  function changeAnswer(id: string, value: string) {
    setAnswers((current) => current.map((answer) => answer.id === id
      ? { ...answer, value, state: value.trim() ? "user-edited" : "blocked", proposal: null, regenerationStatus: undefined }
      : answer));
  }

  function protectAnswer(id: string) {
    setAnswers((current) => current.map((answer) => answer.id === id && answer.value.trim()
      ? { ...answer, state: "protected", proposal: null }
      : answer));
  }

  function regenerateAnswer(id: string) {
    setAnswers((current) => current.map((answer) => {
      if (answer.id !== id) return answer;
      return regeneratedAnswer(answer);
    }));
  }

  function rerunAll() {
    setRerunNotice(true);
    setAnswers((current) => current.map((answer) => regeneratedAnswer(answer)));
  }

  return (
    <div ref={dialogRef} className="fixed inset-0 z-[90] overflow-y-auto bg-background/98 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Guided approach preparation">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-text">Opportunity #{String(opportunity).padStart(3, "0")} · Preparation only</p>
            <h2 className="truncate font-display text-xl text-landing sm:text-2xl">Guided approach</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50" aria-label="Close guided approach">
            <X className="size-5" aria-hidden="true" />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-5 sm:px-6">
        <ol className="mx-auto grid max-w-2xl grid-cols-3 gap-2" aria-label="Guided approach progress">
          {steps.map((step, index) => (
            <li key={step.id} className="min-w-0 text-center" aria-current={step.id === phase ? "step" : undefined}>
              <span className={cn(
                "mx-auto flex size-9 items-center justify-center rounded-full border text-xs font-semibold",
                index < phaseIndex && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                index === phaseIndex && "border-brand bg-brand text-brand-foreground",
                index > phaseIndex && "border-border bg-surface text-faint",
              )}>{index < phaseIndex ? <Check className="size-4" aria-hidden="true" /> : index + 1}</span>
              <span className="mt-2 block truncate text-xs text-muted">{step.label}</span>
            </li>
          ))}
        </ol>

        <section className="mt-6 rounded-3xl border border-border bg-surface/60 p-5 shadow-sm sm:p-8">
          {phase === "choose" && (
            <Choose routes={routes} selectedId={selected.id} onSelect={setSelectedId} onContinue={() => setPhase("prepare")} />
          )}
          {phase === "prepare" && (
            <Prepare
              route={selected}
              draft={draft}
              draftState={draftState}
              answers={answers}
              overLimit={overLimit}
              blocked={blocked}
              copyState={copyState}
              rerunNotice={rerunNotice}
              onDraft={(value) => { setDraft(value); setDraftState("user-edited"); setCopyState("idle"); }}
              onProtectDraft={() => setDraftState("protected")}
              onCopy={copyDraft}
              onAnswer={changeAnswer}
              onProtectAnswer={protectAnswer}
              onRegenerateAnswer={regenerateAnswer}
              onRerunAll={rerunAll}
              onBack={() => setPhase("choose")}
              onContinue={() => setPhase("act")}
            />
          )}
          {phase === "act" && <Act route={selected} onBack={() => setPhase("prepare")} onClose={onClose} />}
        </section>
      </main>
    </div>
  );
}

function answerDrafts(route?: PlanRoute): AnswerDraft[] {
  return (route?.answers ?? []).map((answer) => ({
    ...answer,
    originalValue: answer.value,
    proposal: null,
    regenerationIndex: 0,
  }));
}

function answerBlocked(answer: AnswerDraft) {
  return !answer.value.trim()
    || answer.state === "blocked"
    || (answer.limit != null && answer.value.length > answer.limit);
}

function regeneratedAnswer(answer: AnswerDraft): AnswerDraft {
  if (answer.state === "blocked") return answer;
  const candidates = [...answer.regenerationCandidates, answer.originalValue]
    .filter((candidate, index, all) => candidate && candidate !== answer.value && all.indexOf(candidate) === index);
  const next = candidates[answer.regenerationIndex % Math.max(candidates.length, 1)];
  if (!next) {
    return { ...answer, proposal: null, regenerationStatus: "unavailable" };
  }
  const regenerationIndex = answer.regenerationIndex + 1;
  if (answer.state === "generated") {
    return {
      ...answer,
      value: next,
      proposal: null,
      regenerationIndex,
      regenerationStatus: "changed",
    };
  }
  return {
    ...answer,
    proposal: next,
    regenerationIndex,
    regenerationStatus: "proposed",
  };
}

function Heading({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-text">{eyebrow}</p>
      <h3 className="mt-1 font-display text-3xl text-landing">{title}</h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}

function Choose({ routes, selectedId, onSelect, onContinue }: { routes: PlanRoute[]; selectedId: string; onSelect: (id: string) => void; onContinue: () => void }) {
  return (
    <div>
      <Heading eyebrow="Checkpoint 1 · Canonical ranking" title="Choose one Approach route" body="These routes are read from the canonical Approach Plan. Selecting one changes preparation only and records no Attempt." />
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {routes.map((route) => (
          <button key={route.id} type="button" data-route-type={route.type} onClick={() => onSelect(route.id)} className={cn(
            "min-h-28 rounded-2xl border p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
            selectedId === route.id ? "border-brand/50 bg-brand-soft/45" : "border-border bg-background/35 hover:bg-surface-hover",
          )}>
            <span className="font-mono text-[10px] text-faint">RANK {String(route.rank).padStart(2, "0")} · {routeLabels[route.type]}</span>
            <span className="mt-2 block font-semibold">{route.label}</span>
            <span className="mt-1 block break-words text-xs text-muted">{route.destination || "Destination missing"}</span>
          </button>
        ))}
      </div>
      <div className="mt-7 flex justify-end">
        <PrimaryButton onClick={onContinue}>Prepare this route <ArrowRight className="size-4" aria-hidden="true" /></PrimaryButton>
      </div>
    </div>
  );
}

type PrepareProps = {
  route: PlanRoute;
  draft: string;
  draftState: Exclude<AnswerState, "blocked">;
  answers: AnswerDraft[];
  overLimit: boolean;
  blocked: boolean;
  copyState: "idle" | "copied" | "denied";
  rerunNotice: boolean;
  onDraft: (value: string) => void;
  onProtectDraft: () => void;
  onCopy: () => void;
  onAnswer: (id: string, value: string) => void;
  onProtectAnswer: (id: string) => void;
  onRegenerateAnswer: (id: string) => void;
  onRerunAll: () => void;
  onBack: () => void;
  onContinue: () => void;
};

function Prepare(props: PrepareProps) {
  const { route } = props;
  return (
    <div>
      <Heading eyebrow="Checkpoint 2 · Reviewed material" title={`Prepare ${routeLabels[route.type].toLowerCase()}`} body="Review the destination, limits, instructions, and source-backed content. Missing personal facts stay blank until you provide them." />
      <dl className="mt-5 grid gap-3 rounded-2xl border border-border bg-background/35 p-4 text-sm sm:grid-cols-3">
        <Meta label="Destination" value={route.destination || "Missing"} />
        <Meta label="Channel" value={route.channel || "Missing"} />
        <Meta label="Channel limit" value={route.limit == null ? "No character limit declared" : `${route.limit} characters`} />
      </dl>
      {route.follows && <p className="mt-3 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted">Continues confirmed Attempt <strong className="text-foreground">{route.follows}</strong></p>}
      {route.instruction && <p className="mt-3 rounded-xl border border-brand/25 bg-brand-soft/30 p-3 text-sm text-muted"><FileText className="mr-2 inline size-4 text-brand-text" aria-hidden="true" />{route.instruction}</p>}
      {route.blockedReason && <Block>{route.blockedReason}</Block>}

      {route.type === "application" ? (
        <ApplicationAnswers {...props} />
      ) : (
        <MessageEditor {...props} />
      )}

      <div className="mt-7 flex flex-col-reverse gap-2 border-t border-border pt-5 sm:flex-row sm:justify-between">
        <SecondaryButton onClick={props.onBack}><ArrowLeft className="size-4" aria-hidden="true" /> Routes</SecondaryButton>
        <PrimaryButton disabled={props.blocked} onClick={props.onContinue}>Ready to act <ArrowRight className="size-4" aria-hidden="true" /></PrimaryButton>
      </div>
    </div>
  );
}

function MessageEditor(props: PrepareProps) {
  const visibleState: AnswerState = props.overLimit || props.route.blockedReason ? "blocked" : props.draftState;
  return (
    <div className="mt-5 rounded-2xl border border-border bg-background/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">Sendable text</p>
        <StatePill state={visibleState} />
      </div>
      <textarea aria-label="Prepared message" value={props.draft} onChange={(event) => props.onDraft(event.target.value)} className={cn(
        "mt-3 min-h-48 w-full resize-y rounded-xl border bg-surface p-4 text-sm leading-relaxed outline-none focus-visible:ring-2",
        props.overLimit ? "border-rose-500 focus-visible:ring-rose-500/30" : "border-border focus-visible:ring-brand/30",
      )} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className={cn("font-mono text-[10px]", props.overLimit ? "font-semibold text-rose-700 dark:text-rose-300" : "text-faint")}>
          {props.route.limit == null ? `${props.draft.length} characters · no declared limit` : `${props.draft.length} / ${props.route.limit} characters`}
          {props.overLimit ? " · trim before copying" : ""}
        </p>
        <div className="flex flex-wrap gap-2">
          {props.draftState === "user-edited" && <SecondaryButton onClick={props.onProtectDraft}><LockKeyhole className="size-3.5" aria-hidden="true" /> Protect edit</SecondaryButton>}
          <PrimaryButton disabled={props.overLimit || Boolean(props.route.blockedReason)} onClick={props.onCopy}>
            {props.copyState === "copied" ? <Check className="size-4" aria-hidden="true" /> : <Clipboard className="size-4" aria-hidden="true" />}
            {props.copyState === "copied" ? "Copied, not sent" : "Copy draft"}
          </PrimaryButton>
        </div>
      </div>
      {props.copyState === "denied" && (
        <div role="status" className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted" data-copy-fallback="manual">
          Clipboard access was denied. Select the draft above and copy it manually. Nothing was sent or recorded.
        </div>
      )}
    </div>
  );
}

function ApplicationAnswers(props: PrepareProps) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Application answers in posting order</p>
          <p className="mt-1 text-xs text-muted">Generated-only reruns never replace reviewed values.</p>
        </div>
        <SecondaryButton onClick={props.onRerunAll}><RefreshCw className="size-3.5" aria-hidden="true" /> Rerun all</SecondaryButton>
      </div>
      {props.rerunNotice && (
        <p className="mt-3 text-xs text-faint" role="status">
          Rerun finished. Protected values remain unchanged; source-backed alternatives appear beside them when the canonical plan provides one.
        </p>
      )}
      <div className="mt-4 space-y-3">
        {props.answers.map((answer, index) => (
          <div key={answer.id} className="rounded-2xl border border-border bg-background/35 p-4" data-answer-id={answer.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <label htmlFor={`answer-${answer.id}`} className="text-sm font-semibold"><span className="mr-2 font-mono text-[10px] text-faint">{String(index + 1).padStart(2, "0")}</span>{answer.label}</label>
              <StatePill state={answerBlocked(answer) ? "blocked" : answer.state} />
            </div>
            <textarea id={`answer-${answer.id}`} value={answer.value} placeholder={answer.state === "blocked" ? "Missing personal fact. Left blank." : undefined} onChange={(event) => props.onAnswer(answer.id, event.target.value)} className={cn(
              "mt-3 min-h-24 w-full resize-y rounded-xl border bg-surface p-3 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-brand/30",
              answerBlocked(answer) ? "border-amber-500/45" : "border-border",
            )} />
            <p className={cn(
              "mt-2 font-mono text-[10px]",
              answer.limit != null && answer.value.length > answer.limit ? "font-semibold text-rose-700 dark:text-rose-300" : "text-faint",
            )} data-answer-limit={answer.limit ?? "none"}>
              {answer.limit == null ? `${answer.value.length} characters · no declared limit` : `${answer.value.length} / ${answer.limit} characters`}
              {answer.limit != null && answer.value.length > answer.limit ? " · trim before continuing" : ""}
            </p>
            {answer.instruction && (
              <p className="mt-2 rounded-lg border border-brand/20 bg-brand-soft/25 p-2 text-xs text-muted" data-jd-instruction>
                <strong className="text-foreground">Explicit JD instruction:</strong> {answer.instruction}
              </p>
            )}
            {answer.notes && !answer.instruction && <p className="mt-2 text-xs text-faint">{answer.notes}</p>}
            {answer.proposal && (
              <div className="mt-3 rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-xs" data-rerun-proposal>
                <p className="font-semibold text-sky-800 dark:text-sky-300">Proposed change. Reviewed value kept.</p>
                <p className="mt-1 text-muted">{answer.proposal}</p>
              </div>
            )}
            {answer.regenerationStatus === "changed" && <p className="mt-2 text-[11px] text-faint" role="status">Regenerated from a source-backed alternative in the current canonical plan.</p>}
            {answer.regenerationStatus === "unavailable" && <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300" role="status">No different source-backed alternative is declared. Reviewed text was preserved.</p>}
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <SecondaryButton onClick={() => props.onRegenerateAnswer(answer.id)}><RefreshCw className="size-3.5" aria-hidden="true" /> Regenerate item</SecondaryButton>
              {answer.state === "user-edited" && <SecondaryButton onClick={() => props.onProtectAnswer(answer.id)}><LockKeyhole className="size-3.5" aria-hidden="true" /> Protect edit</SecondaryButton>}
            </div>
          </div>
        ))}
      </div>
      {props.answers.some((answer) => answer.state === "blocked") && <Block>Missing personal facts remain blank blockers. career-ops will not infer them.</Block>}
    </div>
  );
}

function Act({ route, onBack, onClose }: { route: PlanRoute; onBack: () => void; onClose: () => void }) {
  return (
    <div>
      <Heading eyebrow="Checkpoint 3 · Outside career-ops" title="You do this part" body="Use the reviewed material at the declared destination. career-ops sent or submitted nothing, and no Approach Attempt was recorded." />
      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="rounded-2xl border border-border bg-background/35 p-5">
          <div className="flex items-center gap-2"><ExternalLink className="size-4 text-brand-text" aria-hidden="true" /><p className="text-sm font-semibold">Act at the destination</p></div>
          <dl className="mt-4 space-y-3 text-sm">
            <Meta label="Route" value={routeLabels[route.type]} />
            <Meta label="Destination" value={route.destination} />
            <Meta label="Channel" value={route.channel} />
            {route.timing && <Meta label="Timing" value={route.timing} />}
          </dl>
          {route.instruction && <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-muted">{route.instruction}</p>}
        </div>
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.07] p-5">
          <ShieldCheck className="size-5 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
          <p className="mt-3 font-semibold">Preparation boundary intact</p>
          <p className="mt-2 text-sm leading-relaxed text-muted">Copied, edited, opened, and viewed are preparation states. None is an Attempt.</p>
          <p className="mt-3 text-xs text-faint">Reporting and confirmation belong to the next guarded journey.</p>
        </div>
      </div>
      <div className="mt-7 flex flex-col-reverse gap-2 border-t border-border pt-5 sm:flex-row sm:justify-between">
        <SecondaryButton onClick={onBack}><ArrowLeft className="size-4" aria-hidden="true" /> Edit preparation</SecondaryButton>
        <PrimaryButton onClick={onClose}>Close and act outside <ExternalLink className="size-4" aria-hidden="true" /></PrimaryButton>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</dt><dd className="mt-1 break-words font-medium text-foreground">{value}</dd></div>;
}

function Block({ children }: { children: React.ReactNode }) {
  return <div role="status" className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-muted"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" /><span>{children}</span></div>;
}

function PrimaryButton({ disabled = false, onClick, children }: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button type="button" disabled={disabled} onClick={onClick} className="min-h-11 rounded-lg px-4 font-semibold">{children}</Button>;
}

function SecondaryButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <Button type="button" variant="outline" onClick={onClick} className="min-h-11 rounded-lg px-3 text-muted">{children}</Button>;
}
