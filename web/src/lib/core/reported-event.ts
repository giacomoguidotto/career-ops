import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCli } from "@/lib/clis";
import type {
  ApproachAttempt,
  OpportunityDetailResult,
} from "@/lib/core/opportunity-lifecycle";
import { reportableSuccessors } from "@/lib/core/reported-event-contract";

const ATTEMPT_TYPES = new Set([
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
]);

export type ReportRouteContext = {
  id: string;
  type: "outreach" | "application" | "qualifying" | "followup";
  label: string;
  destination: string;
  channel: string;
  follows: string | null;
};

export type ReportedAttemptProposal = {
  kind: "attempt";
  occurredAt: string;
  type: string;
  channel: string;
  recipient: string;
  result: string;
  followUpTo: string | null;
  notes: string;
};

export type ReportedSuccessorProposal = {
  kind: "successor";
  successor: string;
  occurredAt: string;
  result: string;
};

export type ReportedEventProposal = ReportedAttemptProposal | ReportedSuccessorProposal;

export type ReportedEventInterpretation =
  | { kind: "clarification"; question: string }
  | { kind: "proposal"; proposal: ReportedEventProposal };

export class ReportedEventError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1_000;
}

function occurredAt(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function focusedQuestion(value: unknown): string {
  if (present(value)) return value.trim().slice(0, 300);
  return "What exact action or hiring event happened, through which channel, and when?";
}

function extractJson(output: string): unknown {
  const cleaned = output.replace(/\u001b\[[0-9;]*m/g, "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  for (const candidate of [cleaned, fenced].filter((value): value is string => Boolean(value))) {
    try { return JSON.parse(candidate); } catch { /* try a balanced object below */ }
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* handled by caller */ }
  }
  return null;
}

function validateInterpretation(
  value: unknown,
  detail: OpportunityDetailResult,
): ReportedEventInterpretation {
  if (!record(value)) {
    return { kind: "clarification", question: "I could not safely structure that report. What exact event happened?" };
  }
  if (value.kind === "clarification") {
    return { kind: "clarification", question: focusedQuestion(value.question) };
  }
  if (value.kind !== "proposal" || !record(value.proposal)) {
    return { kind: "clarification", question: "What exact action or hiring event happened?" };
  }
  const proposal = value.proposal;
  if (proposal.kind === "attempt") {
    const followUpTo: string | null = typeof proposal.followUpTo === "string" && proposal.followUpTo
      ? proposal.followUpTo
      : null;
    const prior = typeof followUpTo === "string"
      ? detail.attempts.find((attempt) => attempt.id === followUpTo)
      : null;
    if (
      !occurredAt(proposal.occurredAt)
      || !present(proposal.type)
      || !ATTEMPT_TYPES.has(proposal.type)
      || !present(proposal.channel)
      || !present(proposal.recipient)
      || !present(proposal.result)
      || (proposal.notes !== undefined && typeof proposal.notes !== "string")
      || (proposal.type === "follow_up" && !prior)
      || (proposal.type !== "follow_up" && followUpTo !== null)
    ) {
      return { kind: "clarification", question: "Which action did you complete, through which channel, with whom, when, and what was the result?" };
    }
    return {
      kind: "proposal",
      proposal: {
        kind: "attempt",
        occurredAt: proposal.occurredAt,
        type: proposal.type,
        channel: proposal.channel.trim(),
        recipient: proposal.recipient.trim(),
        result: proposal.result.trim(),
        followUpTo,
        notes: typeof proposal.notes === "string" ? proposal.notes.trim() : "",
      },
    };
  }
  if (proposal.kind === "successor") {
    const allowed = reportableSuccessors(detail.opportunity, detail.contract);
    if (
      !present(proposal.successor)
      || !allowed.includes(proposal.successor)
      || !occurredAt(proposal.occurredAt)
      || !present(proposal.result)
    ) {
      return { kind: "clarification", question: "What hiring event happened, and when did it happen?" };
    }
    return {
      kind: "proposal",
      proposal: {
        kind: "successor",
        successor: proposal.successor,
        occurredAt: proposal.occurredAt,
        result: proposal.result.trim(),
      },
    };
  }
  return { kind: "clarification", question: "Was this an action you took, or a new event from the hiring team?" };
}

function promptFor(
  report: string,
  route: ReportRouteContext | null,
  detail: OpportunityDetailResult,
): string {
  const context = {
    today: new Date().toISOString().slice(0, 10),
    opportunity: {
      id: detail.opportunity.opportunity,
      company: detail.opportunity.company,
      role: detail.opportunity.role,
      stage: detail.opportunity.stage,
      revision: detail.opportunity.revision,
      capabilities: detail.opportunity.capabilities,
      reportableSuccessors: reportableSuccessors(detail.opportunity, detail.contract),
    },
    selectedRoute: route,
    attempts: detail.attempts.map((attempt: ApproachAttempt) => ({
      id: attempt.id,
      occurredAt: attempt.date,
      type: attempt.type,
      channel: attempt.channel,
      recipient: attempt.recipient,
      result: attempt.result,
      followUpTo: attempt.followUpTo,
    })),
    report,
  };
  return `CAREER_OPS_REPORTED_EVENT_INTERPRETATION\nYou are a read-only interpretation worker. You cannot write files, change Stage, or record an event.\n\nInterpret the user's natural-language report using only the supplied live Opportunity, selected route, Stage, revision, and Attempt history. Never guess a missing action, channel, recipient, time, result, follow-up relation, or hiring event. If one required fact is missing or ambiguous, ask one focused clarification.\n\nReturn exactly one JSON object and no markdown. Either:\n{"kind":"clarification","question":"one focused question"}\nor\n{"kind":"proposal","proposal":{"kind":"attempt","occurredAt":"ISO 8601 date or timestamp preserving stated precision","type":"one canonical type","channel":"...","recipient":"...","result":"...","followUpTo":null,"notes":""}}\nor\n{"kind":"proposal","proposal":{"kind":"successor","successor":"one live reportable successor id","occurredAt":"ISO 8601 date or timestamp preserving stated precision","result":"..."}}\n\nCanonical Attempt types: ${[...ATTEMPT_TYPES].join(", ")}. A follow_up must reference an existing same-Opportunity Attempt. A non-follow-up must use null. An action that reaches Approached must be an Attempt. A successor must be listed in reportableSuccessors. A typed proposal is only a not-recorded preview.\n\nLIVE CONTEXT\n${JSON.stringify(context)}`;
}

function readOnlyArgs(cliId: string, prompt: string, argsFor: (prompt: string) => string[]): string[] {
  if (cliId === "codex") return ["exec", "--sandbox", "read-only", "--ephemeral", "--skip-git-repo-check", prompt];
  if (cliId === "claude") {
    return [
      "-p", prompt,
      "--permission-mode", "plan",
      "--strict-mcp-config",
      "--allowedTools", "Read",
      "--disallowedTools", "Bash,Write,Edit,NotebookEdit,Task,WebFetch,WebSearch",
    ];
  }
  return argsFor(prompt);
}

function runInterpreter(binPath: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ReportedEventError("interpreter-timeout", "The interpretation worker timed out.", 504));
    }, 60_000);
    child.stdout.on("data", (chunk) => { if (stdout.length < 128_000) stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 16_000) stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ReportedEventError("interpreter-unavailable", error.message, 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new ReportedEventError("interpreter-failed", "The interpretation worker did not return a usable result.", 503));
    });
  });
}

export async function interpretReportedEvent(options: {
  root: string;
  cliId: string;
  report: string;
  route: ReportRouteContext | null;
  detail: OpportunityDetailResult;
}): Promise<ReportedEventInterpretation> {
  const report = options.report.trim();
  if (!report || report.length > 8_000) {
    throw new ReportedEventError("invalid-report", "The event report must be between 1 and 8,000 characters.", 400);
  }
  const resolved = resolveCli(options.cliId);
  if (!resolved) {
    throw new ReportedEventError("interpreter-unavailable", `CLI '${options.cliId}' is not available.`, 404);
  }
  const prompt = promptFor(report, options.route, options.detail);
  const isolatedRoot = mkdtempSync(join(tmpdir(), "career-ops-reported-event-"));
  try {
    const output = await runInterpreter(
      resolved.binPath,
      readOnlyArgs(options.cliId, prompt, resolved.spec.args),
      isolatedRoot,
    );
    return validateInterpretation(extractJson(output), options.detail);
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}
