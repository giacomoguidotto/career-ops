"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Command,
  Compass,
  FileCheck2,
  Keyboard,
  LockKeyhole,
  PanelRightClose,
  PanelRightOpen,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import type { InboxJob } from "@/lib/career-ops";
import type { OpportunityListResult, OpportunitySummary } from "@/lib/core/opportunity-lifecycle";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { InboxTriage } from "@/components/inbox/inbox-triage";
import { scoreNum, scoreTone } from "@/lib/format";
import { cn } from "@/lib/cn";

type Stage = OpportunityListResult["contract"]["stages"][number];
type DialogKind = "commands" | "help" | "prepare" | "report";
const SORT_KEYS = ["company", "role", "score", "status", "date"] as const;
type SortKey = (typeof SORT_KEYS)[number];

function humanize(value: string | null): string {
  if (!value) return "No next action";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ownerLabel(owner: OpportunitySummary["stage"]["owner"]): string {
  if (owner === "agent") return "Agent";
  if (owner === "user") return "You";
  if (owner === "external") return "External";
  return "None";
}

function ownerIcon(owner: OpportunitySummary["stage"]["owner"]) {
  if (owner === "agent") return Bot;
  if (owner === "user") return UserRound;
  if (owner === "external") return UsersRound;
  return Check;
}

function attentionLabel(opportunity: OpportunitySummary): string {
  const next = opportunity.attemptAttention.nextReview;
  if (opportunity.attemptAttention.state === "urgent") return "Needs attention now";
  if (opportunity.attemptAttention.state === "review_due") return next ? `Review due ${next}` : "Review due";
  if (opportunity.attemptAttention.state === "waiting") return next ? `Waiting until ${next}` : "Waiting";
  if (opportunity.attemptAttention.state === "cold") return "Cold review";
  if (opportunity.attemptAttention.state === "unknown") return "Attention unknown";
  return "No immediate attention";
}

function stageTone(stage: OpportunitySummary["stage"]): "warn" | "muted" {
  return stage.owner === "user" ? "warn" : "muted";
}

function compareOpportunities(left: OpportunitySummary, right: OpportunitySummary, key: SortKey, direction: 1 | -1): number {
  if (key === "score") {
    const leftScore = scoreNum(left.score);
    const rightScore = scoreNum(right.score);
    const leftValue = Number.isNaN(leftScore) ? Number.NEGATIVE_INFINITY : leftScore;
    const rightValue = Number.isNaN(rightScore) ? Number.NEGATIVE_INFINITY : rightScore;
    return (leftValue - rightValue) * direction;
  }
  const leftValue = key === "status" ? left.stage.label : left[key];
  const rightValue = key === "status" ? right.stage.label : right[key];
  return leftValue.localeCompare(rightValue) * direction;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || Boolean(target.closest("input, textarea, select, [contenteditable='true']")));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("a, button, input, textarea, select, summary, [role='button'], [contenteditable='true']"));
}

export function PipelineView({
  lifecycle,
  inbox,
}: {
  lifecycle: OpportunityListResult | null;
  inbox: InboxJob[];
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [temporaryPreview, setTemporaryPreview] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(true);

  const stages = useMemo(() => lifecycle?.contract.stages ?? [], [lifecycle]);
  const opportunities = useMemo(() => lifecycle?.opportunities ?? [], [lifecycle]);
  const legacyTab = (params.get("tab") ?? "").trim();
  const inboxOpen = params.get("view") === "inbox" || legacyTab.toUpperCase() === "INBOX";
  const explicitStage = (params.get("stage") ?? "").trim();
  const legacyStage = (
    legacyTab && !["ALL", "INBOX"].includes(legacyTab.toUpperCase()) ? legacyTab : ""
  );
  const requestedStage = explicitStage || legacyStage;
  const activeDashboardGroup = !explicitStage && legacyStage
    ? stages.find((stage) => stage.dashboardGroup.toLowerCase() === legacyStage.toLowerCase())?.dashboardGroup ?? null
    : null;
  const activeStage = stages.find((stage) => {
    const requested = requestedStage.toLowerCase();
    return stage.id.toLowerCase() === requested
      || stage.label.toLowerCase() === requested;
  }) ?? stages.find((stage) => {
    const requested = requestedStage.toLowerCase();
    return !explicitStage && stage.dashboardGroup.toLowerCase() === requested;
  }) ?? null;
  const pMin = Number.parseFloat(params.get("min") ?? "");
  const minFilter = Number.isFinite(pMin) ? pMin : null;
  const requestedSort = params.get("sort") ?? "";
  const sortKey = (SORT_KEYS as readonly string[]).includes(requestedSort) ? requestedSort as SortKey : null;
  const sortDirection: 1 | -1 = params.get("dir") === "1" ? 1 : -1;

  const [query, setQuery] = useState(params.get("q") ?? "");
  const lastUrlQuery = useRef(params.get("q") ?? "");
  useEffect(() => {
    const urlQuery = params.get("q") ?? "";
    if (urlQuery !== lastUrlQuery.current) {
      lastUrlQuery.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [params]);

  const setParams = useCallback((updates: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, String(value));
    }
    const queryString = next.toString();
    router.replace(`${pathname}${queryString ? `?${queryString}` : ""}`, { scroll: false });
  }, [params, pathname, router]);

  const pendingInbox = useMemo(() => {
    const seen = new Set<string>();
    return inbox.filter((item) => {
      if (item.done || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  }, [inbox]);

  const stageRows = useMemo(() => opportunities.filter((opportunity) => {
    if (activeDashboardGroup && opportunity.stage.dashboardGroup !== activeDashboardGroup) return false;
    if (!activeDashboardGroup && activeStage && opportunity.stage.id !== activeStage.id) return false;
    if (minFilter == null) return true;
    const score = scoreNum(opportunity.score);
    return !Number.isNaN(score) && score >= minFilter;
  }), [activeDashboardGroup, activeStage, minFilter, opportunities]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle ? stageRows.filter((opportunity) => [
      opportunity.company,
      opportunity.role,
      opportunity.stage.label,
      humanize(opportunity.stage.suggests),
      attentionLabel(opportunity),
    ].join(" ").toLowerCase().includes(needle)) : stageRows;
    return sortKey ? [...matching].sort((left, right) => compareOpportunities(left, right, sortKey, sortDirection)) : matching;
  }, [query, sortDirection, sortKey, stageRows]);

  const selectedParam = Number(params.get("selected"));
  const selectedId = Number.isSafeInteger(selectedParam) && selectedParam > 0 ? selectedParam : null;
  const stageSelection = stageRows.find((opportunity) => opportunity.opportunity === selectedId) ?? visible[0] ?? stageRows[0] ?? null;
  const selected = visible.find((opportunity) => opportunity.opportunity === selectedId) ?? visible[0] ?? null;
  const previewed = visible.find((opportunity) => opportunity.opportunity === temporaryPreview) ?? selected;

  useEffect(() => {
    if (inboxOpen) return;
    const canonical = stageSelection?.opportunity ?? null;
    if (canonical !== selectedId) setParams({ selected: canonical });
  }, [inboxOpen, selectedId, setParams, stageSelection?.opportunity]);

  const select = useCallback((opportunity: number) => {
    setParams(activeDashboardGroup
      ? { selected: opportunity, stage: null, tab: legacyTab, view: null }
      : { selected: opportunity, stage: activeStage?.id ?? null, tab: null, view: null });
  }, [activeDashboardGroup, activeStage?.id, legacyTab, setParams]);

  const focusOpportunity = useCallback((opportunity: number) => {
    requestAnimationFrame(() => {
      const candidates = document.querySelectorAll<HTMLElement>(`[data-opportunity-id="${opportunity}"]`);
      const visibleCandidate = [...candidates].find((candidate) => candidate.getClientRects().length > 0);
      visibleCandidate?.focus();
    });
  }, []);

  const moveSelection = useCallback((offset: number) => {
    if (!visible.length) return;
    const current = visible.findIndex((opportunity) => opportunity.opportunity === selected?.opportunity);
    const index = current < 0 ? 0 : current;
    const next = visible[(index + offset + visible.length) % visible.length];
    select(next.opportunity);
    focusOpportunity(next.opportunity);
  }, [focusOpportunity, select, selected?.opportunity, visible]);

  const openDialog = useCallback((kind: DialogKind) => {
    if (dialog === null && document.activeElement instanceof HTMLElement) {
      restoreFocusRef.current = document.activeElement;
    }
    setDialog(kind);
  }, [dialog]);

  const closeDialog = useCallback(() => {
    setDialog(null);
    requestAnimationFrame(() => restoreFocusRef.current?.focus());
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialog !== null) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeDialog();
        }
        return;
      }
      if (isTypingTarget(event.target)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openDialog("commands");
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (!inboxOpen && event.key.toLowerCase() === "j") {
        event.preventDefault();
        moveSelection(1);
      } else if (!inboxOpen && event.key.toLowerCase() === "k") {
        event.preventDefault();
        moveSelection(-1);
      } else if (!inboxOpen && event.key === "Enter" && selected && !isInteractiveTarget(event.target)) {
        event.preventDefault();
        router.push(`/pipeline/${selected.opportunity}`);
      } else if (event.key === "?") {
        event.preventDefault();
        openDialog("help");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog, dialog, inboxOpen, moveSelection, openDialog, router, selected]);

  const setStage = useCallback((stage: Stage | null) => {
    setTemporaryPreview(null);
    setParams({ stage: stage?.id ?? null, selected: null, tab: null, view: null });
  }, [setParams]);

  if (!lifecycle) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-7 pb-24 sm:px-6 lg:px-8">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand-text">Upstream triage</p>
          <h1 className="mt-1 font-display text-3xl tracking-tight text-landing sm:text-4xl">Pipeline</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Inbox triage remains available while this checkout upgrades its lifecycle reader.
          </p>
        </div>
        <section className="mt-6" aria-labelledby="compatibility-inbox-heading">
          <div className="border-b border-border pb-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Lifecycle data is unavailable</p>
            <h2 id="compatibility-inbox-heading" className="mt-1 font-display text-2xl text-landing">Inbox</h2>
            <p className="mt-1 text-sm text-muted">This checkout cannot provide the canonical passive Opportunity contract yet.</p>
          </div>
          {pendingInbox.length ? <InboxTriage inbox={pendingInbox} /> : <InboxEmpty />}
        </section>
      </main>
    );
  }

  return (
    <>
      <main className="pipeline-ledger mx-auto max-w-[1400px] px-4 py-7 pb-24 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand-text">Operational overview</p>
            <h1 className="mt-1 font-display text-3xl tracking-tight text-landing sm:text-4xl">Pipeline</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
              Scan canonical Stages, preview without changing selection, then open one complete Opportunity.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 lg:w-[25rem]">
            <Metric value={opportunities.length} label="tracked" />
            <Metric value={opportunities.filter((item) => item.stage.owner === "user").length} label="need you" accent />
            <Metric
              value={pendingInbox.length}
              label="in inbox"
              active={inboxOpen}
              onClick={() => setParams(activeDashboardGroup
                ? { view: inboxOpen ? null : "inbox", stage: null, tab: legacyTab }
                : { view: inboxOpen ? null : "inbox", stage: activeStage?.id ?? null, tab: null })}
            />
          </div>
        </div>

        {inboxOpen ? (
          <section className="mt-6" aria-labelledby="inbox-heading">
            <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Upstream triage, outside lifecycle Stages</p>
                <h2 id="inbox-heading" className="mt-1 font-display text-2xl text-landing">Inbox</h2>
              </div>
              <button
                type="button"
                onClick={() => setParams({ view: null, tab: activeDashboardGroup ? legacyTab : null })}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface/70 px-4 text-sm font-medium transition hover:border-brand/35 hover:text-brand-text motion-reduce:transition-none"
              >
                Return to Stage ledger <ArrowRight className="size-4" />
              </button>
            </div>
            {pendingInbox.length ? <InboxTriage inbox={pendingInbox} /> : <InboxEmpty />}
          </section>
        ) : (
          <>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="relative min-w-0 flex-1">
                <span className="sr-only">Search Pipeline</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search company, role, Stage, or next action"
                  className="min-h-11 w-full rounded-lg border border-border bg-surface/70 py-2 pl-9 pr-12 text-sm outline-none transition focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/35 motion-reduce:transition-none"
                />
                <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-border bg-surface-hover px-1.5 py-0.5 font-mono text-[10px] text-faint">/</kbd>
              </label>
              <button
                type="button"
                data-testid="pipeline-commands-trigger"
                onClick={() => openDialog("commands")}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-surface/70 px-3 text-sm font-medium transition hover:border-brand/35 hover:text-brand-text motion-reduce:transition-none"
              >
                <Command className="size-4" /> Commands <kbd className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[10px] text-faint">⌘K</kbd>
              </button>
              <button
                type="button"
                onClick={() => openDialog("help")}
                aria-label="Keyboard help"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border bg-surface/70 text-muted transition hover:border-brand/35 hover:text-brand-text motion-reduce:transition-none"
              >
                <Keyboard className="size-4" />
              </button>
            </div>

            <div className="mt-5 overflow-x-auto border-b border-border" role="group" aria-label="Filter by Stage">
              <div className="flex min-w-max gap-1">
                <StageTab label="All" count={opportunities.length} active={activeStage === null && activeDashboardGroup === null} onClick={() => setStage(null)} />
                {stages.map((stage) => (
                  <StageTab
                    key={stage.id}
                    label={stage.label}
                    count={opportunities.filter((item) => item.stage.id === stage.id).length}
                    active={activeDashboardGroup ? stage.dashboardGroup === activeDashboardGroup : activeStage?.id === stage.id}
                    onClick={() => setStage(stage)}
                  />
                ))}
              </div>
            </div>

            {minFilter != null && (
              <div className="mt-3 flex items-center gap-2">
                <span className="text-xs text-faint">Filtered:</span>
                <button
                  type="button"
                  onClick={() => setParams({ min: null })}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 text-xs font-medium text-brand-text"
                >
                  fit ≥ {minFilter.toFixed(1)} <X className="size-3" />
                </button>
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              <label className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-surface/70 px-3 text-xs text-muted">
                <span>Sort by</span>
                <select
                  aria-label="Sort Opportunities"
                  value={sortKey ?? ""}
                  onChange={(event) => setParams({ sort: event.target.value || null, dir: event.target.value ? sortDirection : null })}
                  className="bg-transparent font-medium text-foreground outline-none"
                >
                  <option value="">Tracker order</option>
                  <option value="company">Company</option>
                  <option value="role">Role</option>
                  <option value="score">Fit</option>
                  <option value="status">Stage</option>
                  <option value="date">Date</option>
                </select>
              </label>
              <button
                type="button"
                disabled={!sortKey}
                aria-label={sortDirection === 1 ? "Sort ascending" : "Sort descending"}
                onClick={() => setParams({ dir: sortDirection === 1 ? -1 : 1 })}
                className="inline-flex min-h-11 items-center rounded-lg border border-border bg-surface/70 px-3 text-xs font-medium text-muted transition hover:border-brand/35 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none"
              >
                {sortDirection === 1 ? "Ascending" : "Descending"}
              </button>
              <button
                type="button"
                aria-expanded={previewOpen}
                onClick={() => setPreviewOpen((value) => !value)}
                className="hidden min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-medium text-muted transition hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 motion-reduce:transition-none xl:inline-flex"
              >
                {previewOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
                {previewOpen ? "Hide preview" : "Show preview"}
              </button>
            </div>

            <div className={cn("grid gap-4", previewOpen && "xl:grid-cols-[minmax(0,1fr)_19rem]")}>
              <section className="overflow-hidden rounded-2xl border border-border bg-surface/35" aria-label="Opportunities">
                {visible.length ? (
                  <>
                    <table className="hidden w-full table-fixed text-sm lg:table">
                      <thead className="border-b border-border bg-surface/70 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-faint">
                        <tr>
                          <th className="w-[27%] px-4 py-3 font-medium">Opportunity</th>
                          <th className="w-[15%] px-3 py-3 font-medium">Stage</th>
                          <th className="w-[12%] px-3 py-3 font-medium">Owner</th>
                          <th className="w-[17%] px-3 py-3 font-medium">Attention</th>
                          <th className="px-3 py-3 font-medium">Suggests</th>
                          <th className="w-16 px-3 py-3 font-medium">Fit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {visible.map((opportunity) => (
                          <LedgerRow
                            key={opportunity.opportunity}
                            opportunity={opportunity}
                            selected={selected?.opportunity === opportunity.opportunity}
                            previewed={previewed?.opportunity === opportunity.opportunity}
                            onPreview={setTemporaryPreview}
                            onOpen={(id) => router.push(`/pipeline/${id}`)}
                          />
                        ))}
                      </tbody>
                    </table>
                    <div className="divide-y divide-border lg:hidden">
                      {visible.map((opportunity) => (
                        <MobileOpportunity
                          key={opportunity.opportunity}
                          opportunity={opportunity}
                          selected={selected?.opportunity === opportunity.opportunity}
                          onPreview={setTemporaryPreview}
                        />
                      ))}
                    </div>
                  </>
                ) : <EmptyRows />}
              </section>
              {previewOpen && <SelectionInspector selected={previewed} />}
            </div>

            <p className="mt-4 text-center text-[11px] text-faint">
              Hover or focus previews · <kbd>J</kbd>/<kbd>K</kbd> selects · <kbd>Enter</kbd> opens · <kbd>/</kbd> searches · <kbd>?</kbd> shows help
            </p>
            <p className="sr-only" aria-live="polite">
              {selected ? `Selected Opportunity ${selected.opportunity}, ${selected.company}` : "No Opportunity selected"}
            </p>
          </>
        )}
      </main>

      {dialog === "commands" && (
        <CommandPalette
          selected={selected}
          onClose={closeDialog}
          onOpen={() => selected && router.push(`/pipeline/${selected.opportunity}`)}
          onShowAll={() => {
            closeDialog();
            setStage(null);
          }}
          onReview={(kind) => setDialog(kind)}
        />
      )}
      {dialog === "help" && <ShortcutHelp onClose={closeDialog} />}
      {(dialog === "prepare" || dialog === "report") && (
        <GuardedReview kind={dialog} selected={selected} onClose={closeDialog} />
      )}
    </>
  );
}

function Metric({
  value,
  label,
  accent = false,
  active = false,
  onClick,
}: {
  value: number;
  label: string;
  accent?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const classes = cn(
    "min-h-16 rounded-xl border px-3 py-2.5 text-left",
    accent ? "border-brand/30 bg-brand-soft/50" : "border-border bg-surface/45",
    onClick && "transition hover:border-brand/35 hover:bg-brand-soft/25 motion-reduce:transition-none",
    active && "border-brand bg-brand-soft/55",
  );
  const content = (
    <>
      <p className="font-display text-2xl leading-none text-landing">{value}</p>
      <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-faint">{label}</p>
    </>
  );
  return onClick ? <button type="button" aria-pressed={active} onClick={onClick} className={classes}>{content}</button> : <div className={classes}>{content}</div>;
}

function StageTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "-mb-px inline-flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition motion-reduce:transition-none",
        active ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
      )}
    >
      {label} <span className="tabular-nums text-faint">{count}</span>
    </button>
  );
}

function LedgerRow({
  opportunity,
  selected,
  previewed,
  onPreview,
  onOpen,
}: {
  opportunity: OpportunitySummary;
  selected: boolean;
  previewed: boolean;
  onPreview: (id: number | null) => void;
  onOpen: (id: number) => void;
}) {
  const OwnerIcon = ownerIcon(opportunity.stage.owner);
  return (
    <tr
      tabIndex={0}
      data-opportunity-id={opportunity.opportunity}
      data-selected={selected ? "true" : "false"}
      aria-label={`Open ${opportunity.company}, ${opportunity.role}${selected ? ", selected" : ""}`}
      onMouseEnter={() => onPreview(opportunity.opportunity)}
      onMouseLeave={() => onPreview(null)}
      onFocus={() => onPreview(opportunity.opportunity)}
      onBlur={() => onPreview(null)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, input, textarea, select")) return;
        onOpen(opportunity.opportunity);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        onOpen(opportunity.opportunity);
      }}
      className={cn(
        "cursor-pointer align-top transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/50 motion-reduce:transition-none",
        previewed ? "bg-brand-soft/55 shadow-[inset_3px_0_0_var(--color-brand)]" : "hover:bg-surface-hover/70",
        selected && "ring-1 ring-inset ring-brand/35",
      )}
    >
      <td className="px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <CompanyLogo name={opportunity.company} size={28} />
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <p className="font-semibold">{opportunity.company}</p>
            <p className="text-xs leading-relaxed text-muted">#{String(opportunity.opportunity).padStart(3, "0")} · {opportunity.role}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3"><Badge tone={stageTone(opportunity.stage)}>{opportunity.stage.label}</Badge></td>
      <td className="px-3 py-3 text-muted"><span className="inline-flex items-center gap-1.5"><OwnerIcon className="size-3.5 shrink-0" /> {ownerLabel(opportunity.stage.owner)}</span></td>
      <td className="px-3 py-3 text-xs leading-relaxed [overflow-wrap:anywhere]">{attentionLabel(opportunity)}</td>
      <td className="px-3 py-3 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">{humanize(opportunity.stage.suggests)}</td>
      <td className="px-3 py-3"><Badge tone={scoreTone(opportunity.score)}>{opportunity.score || "N/A"}</Badge></td>
    </tr>
  );
}

function MobileOpportunity({
  opportunity,
  selected,
  onPreview,
}: {
  opportunity: OpportunitySummary;
  selected: boolean;
  onPreview: (id: number | null) => void;
}) {
  const OwnerIcon = ownerIcon(opportunity.stage.owner);
  return (
    <Link
      href={`/pipeline/${opportunity.opportunity}`}
      data-opportunity-id={opportunity.opportunity}
      data-selected={selected ? "true" : "false"}
      onFocus={() => onPreview(opportunity.opportunity)}
      onBlur={() => onPreview(null)}
      className={cn(
        "block min-h-11 w-full p-4 text-left transition hover:bg-surface-hover/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/50 motion-reduce:transition-none",
        selected && "bg-brand-soft/35 shadow-[inset_3px_0_0_var(--color-brand)]",
      )}
    >
      <div className="flex items-start gap-3">
        <CompanyLogo name={opportunity.company} size={34} retryable={false} />
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <p className="font-semibold">{opportunity.company}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">#{String(opportunity.opportunity).padStart(3, "0")} · {opportunity.role}</p>
          <dl className="mt-4 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs leading-relaxed">
            <dt className="text-faint">Stage</dt><dd><Badge tone={stageTone(opportunity.stage)}>{opportunity.stage.label}</Badge></dd>
            <dt className="text-faint">Owner</dt><dd className="inline-flex items-center gap-1.5 text-muted"><OwnerIcon className="size-3.5 shrink-0" /> {ownerLabel(opportunity.stage.owner)}</dd>
            <dt className="text-faint">Attention</dt><dd>{attentionLabel(opportunity)}</dd>
            <dt className="text-faint">Suggests</dt><dd className="text-muted">{humanize(opportunity.stage.suggests)}</dd>
            <dt className="text-faint">Fit</dt><dd><Badge tone={scoreTone(opportunity.score)}>{opportunity.score || "N/A"}</Badge></dd>
          </dl>
          <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-brand-text">Open Opportunity <ArrowRight className="size-3.5" /></span>
        </div>
      </div>
    </Link>
  );
}

function SelectionInspector({ selected }: { selected: OpportunitySummary | null }) {
  if (!selected) {
    return <aside className="hidden rounded-2xl border border-dashed border-border p-5 text-sm text-muted xl:block">No Opportunity matches this view.</aside>;
  }
  const OwnerIcon = ownerIcon(selected.stage.owner);
  return (
    <aside data-testid="pipeline-preview" className="hidden h-fit rounded-2xl border border-border bg-surface/70 p-5 xl:sticky xl:top-5 xl:block">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">Preview · #{String(selected.opportunity).padStart(3, "0")}</p>
      <div className="mt-3 flex items-start gap-3">
        <CompanyLogo name={selected.company} size={40} />
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <h2 className="font-display text-2xl leading-tight text-landing">{selected.company}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">{selected.role}</p>
        </div>
      </div>
      <dl className="mt-5 space-y-3 border-y border-border py-4 text-xs">
        <InspectorLine label="Stage" value={selected.stage.label} />
        <InspectorLine label="Owner" value={<span className="inline-flex items-center gap-1.5"><OwnerIcon className="size-3.5" />{ownerLabel(selected.stage.owner)}</span>} />
        <InspectorLine label="Attention" value={attentionLabel(selected)} />
        <InspectorLine label="Location" value={selected.location || "Not provided"} />
      </dl>
      <p className="mt-4 text-sm font-semibold [overflow-wrap:anywhere]">{humanize(selected.stage.suggests)}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">Open the working surface for evidence, artifacts, and any safeguarded action.</p>
      <Link href={`/pipeline/${selected.opportunity}`} className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground transition hover:bg-brand-200 motion-reduce:transition-none">
        Open Opportunity <ArrowRight className="size-4" />
      </Link>
    </aside>
  );
}

function InspectorLine({ label, value }: { label: string; value: ReactNode }) {
  return <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2"><dt className="text-faint">{label}</dt><dd className="font-medium text-foreground [overflow-wrap:anywhere]">{value}</dd></div>;
}

function EmptyRows() {
  return (
    <div className="px-6 py-16 text-center">
      <p className="font-display text-xl text-landing">No Opportunities here</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Change the Stage or search phrase. The Stage selection remains shareable in the current URL.</p>
    </div>
  );
}

function InboxEmpty() {
  return (
    <div className="dot-bg mt-4 overflow-hidden rounded-2xl border border-border bg-surface/50 bg-origin-border bg-gradient-to-tr from-brand/10 via-transparent to-transparent shadow-lg">
      <div className="px-6 py-10 text-center">
        <p className="font-display text-lg">Your <span className="text-brand-text">inbox</span> is empty.</p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">Find roles that match your CV, free and without spending tokens.</p>
        <Link href="/explore?run=1" className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground shadow-sm transition hover:bg-brand-200 motion-reduce:transition-none">
          <Compass className="size-4" /> Run your first free scan <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}

function DialogFrame({ title, description, onClose, children }: { title: string; description: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const initial = panelRef.current?.querySelector<HTMLElement>("[data-dialog-initial]")
      ?? panelRef.current?.querySelector<HTMLElement>("button, a, input");
    initial?.focus();
  }, []);

  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])]
      .filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/55 px-4 py-[8vh] backdrop-blur-sm" role="presentation">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pipeline-dialog-title"
        aria-describedby="pipeline-dialog-description"
        onKeyDown={trapFocus}
        className="max-h-[84vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
      >
        <header className="flex items-start gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="pipeline-dialog-title" className="font-display text-2xl text-landing">{title}</h2>
            <p id="pipeline-dialog-description" className="mt-1 text-sm leading-relaxed text-muted">{description}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-hover hover:text-foreground">
            <X className="size-4" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function CommandPalette({
  selected,
  onClose,
  onOpen,
  onShowAll,
  onReview,
}: {
  selected: OpportunitySummary | null;
  onClose: () => void;
  onOpen: () => void;
  onShowAll: () => void;
  onReview: (kind: "prepare" | "report") => void;
}) {
  const [query, setQuery] = useState("");
  const commands = [
    { icon: ArrowRight, label: "Open selected Opportunity", detail: "Navigation, direct", disabled: !selected, action: onOpen },
    { icon: Check, label: "Show every Stage", detail: "Filter, direct", disabled: false, action: onShowAll },
    { icon: Sparkles, label: "Prepare suggested artifact", detail: "Guarded, opens review", disabled: !selected, action: () => onReview("prepare") },
    { icon: FileCheck2, label: "Report a real-world event", detail: "Guarded, opens review", disabled: !selected, action: () => onReview("report") },
  ].filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <DialogFrame title="Pipeline commands" description={selected ? `Selected: #${String(selected.opportunity).padStart(3, "0")} · ${selected.company}` : "No Opportunity is selected."} onClose={onClose}>
      <div className="p-3">
        <label className="relative block">
          <span className="sr-only">Search commands</span>
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input data-dialog-initial value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Type a command" className="min-h-11 w-full rounded-lg border border-border bg-surface/65 pl-9 pr-3 text-sm outline-none focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/35" />
        </label>
        <div className="mt-2 space-y-1">
          {commands.map((item) => (
            <button type="button" key={item.label} disabled={item.disabled} onClick={item.action} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left transition hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none">
              <item.icon className="size-4 text-brand-text" />
              <span className="flex-1"><span className="block text-sm font-medium">{item.label}</span><span className="block text-[11px] text-faint">{item.detail}</span></span>
              <ChevronRight className="size-4 text-faint" />
            </button>
          ))}
        </div>
      </div>
      <footer className="border-t border-border px-5 py-3 text-[11px] text-faint">Guarded commands open another review surface. They never execute from this palette.</footer>
    </DialogFrame>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ["J / K", "Select next or previous visible Opportunity"],
    ["Enter", "Open the selected Opportunity"],
    ["/", "Focus Pipeline search"],
    ["⌘ K", "Open the command palette"],
    ["?", "Open this help"],
    ["Esc", "Close the current dialog"],
  ];
  return (
    <DialogFrame title="Keyboard navigation" description="Direct keys stay narrow, discoverable, and safe around typing and dialogs." onClose={onClose}>
      <div className="divide-y divide-border px-5">
        {shortcuts.map(([keys, label]) => <div key={keys} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-4 py-3 text-sm"><kbd className="font-mono text-xs font-semibold text-foreground">{keys}</kbd><span className="text-muted">{label}</span></div>)}
      </div>
      <div className="m-5 rounded-xl border border-brand/25 bg-brand-soft/45 p-4 text-xs leading-relaxed text-muted">
        <ShieldCheck className="mb-2 size-5 text-brand-text" />
        Shortcuts pause inside inputs and while a dialog is open. Mutations always require an explicit review boundary.
      </div>
    </DialogFrame>
  );
}

function GuardedReview({ kind, selected, onClose }: { kind: "prepare" | "report"; selected: OpportunitySummary | null; onClose: () => void }) {
  const copy = kind === "prepare"
    ? { title: "Review preparation", body: "Generation is supervised. It does not contact anyone or advance a World Stage.", icon: Sparkles }
    : { title: "Review event reporting", body: "A real-world event needs typed facts and canonical consequences before anything is recorded.", icon: FileCheck2 };
  return (
    <DialogFrame title={copy.title} description={selected ? `#${String(selected.opportunity).padStart(3, "0")} · ${selected.company}` : "No Opportunity is selected."} onClose={onClose}>
      <div className="p-5">
        <div className="rounded-xl border border-brand/25 bg-brand-soft/45 p-4">
          <copy.icon className="size-5 text-brand-text" />
          <p className="mt-2 text-sm leading-relaxed text-muted">{copy.body}</p>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium hover:bg-surface-hover">Cancel</button>
          {selected && (
            <Link href={`/pipeline/${selected.opportunity}`} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 text-sm font-semibold text-brand-foreground hover:bg-brand-200">
              Continue on Opportunity <ArrowRight className="size-4" />
            </Link>
          )}
        </div>
        <p className="mt-3 text-center text-[11px] text-faint"><LockKeyhole className="mr-1 inline size-3" />Nothing executes from this review.</p>
      </div>
    </DialogFrame>
  );
}
