import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import {
  acquireTrackerWrite,
  acquireWorker,
  releaseTrackerWrite,
  releaseWorker,
} from "@/lib/core/run-registry";
import { LifecycleAdapterError, readOpportunityLifecycle, requestOpportunityWork, type LifecycleWorkOrder } from "@/lib/core/opportunity-lifecycle";
import { recoverLifecycleWork, type WorkRecoveryTrigger } from "@/lib/core/work-recovery";
import { owningGroupForChild, ownsGroupChild } from "@/lib/core/work-group-store";
import {
  appendWorkerPhase,
  createDurableWorker,
  readDurableWorker,
  settleDurableWorker,
} from "@/lib/core/worker-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

// The web ORCHESTRATES the real career-ops engine — it does NOT reimplement it.
// kind "evaluate" runs the REAL modes/offer.md and persists the canonical
// artifacts (A–F report + tracker row) via the SAME scripts the CLI uses
// (reserve-report-num.mjs → reports/ → batch/tracker-additions/ → merge-tracker.mjs),
// so a web evaluation is byte-identical to a CLI one (single source of truth, no
// drift). kind "research" stays read-only. Streams progress as NDJSON events.
function buildPrompt(kind: string, input: string, memory: string, today: string): string {
  const mem = memory.trim() ? `\n\nDurable notes about the user (from their profile):\n${memory.trim()}\n` : "";
  if (kind === "lifecycle") {
    const workOrder = JSON.parse(input) as LifecycleWorkOrder;
    return `You are fulfilling one explicit, canonical career-ops work order on the user's machine.

Read modes/next.md and the in-scope candidate sources it requires. Fulfill only this work order:
${JSON.stringify(workOrder, null, 2)}

Generate the named ${workOrder.artifact.kind} artifact for Opportunity #${workOrder.opportunity} in ${workOrder.artifact.directory}. Starting and streaming this work must not change Stage. Do not send, submit, contact anyone, fill a live form, or record a real-world action.

After the canonical artifact is complete, reconcile it through the guarded lifecycle seam:
node opportunity-lifecycle.mjs reconcile --opportunity ${workOrder.opportunity} --expected-stage ${workOrder.source.stage} --expected-revision ${workOrder.source.revision}

If reconciliation reports a conflict or block, preserve the artifact and report the exact canonical outcome. Do not edit the tracker directly.

End with EXACTLY one final line: VERDICT: {5 if the artifact was completed and reconciled, else 1}/5 | {content-safe outcome in 12 words or fewer}`;
  }
  if (kind === "research") {
    return `You are investigating the user's OWN work / portfolio to surface job-search-relevant strengths, headless. Investigate the target (use WebFetch for URLs; read local files if referenced) and report: what it is, why it is impressive, and how to leverage it in their job search — which roles/claims it supports and how to frame it on a CV. Be specific, honest, and encouraging.${mem}

End with EXACTLY one final line: VERDICT: {0-5 signal strength}/5 — {why it helps their search, ≤12 words}

Target: ${input}`;
  }
  if (kind === "pdf") {
    return `You are generating the user's ATS-optimized, TAILORED CV PDF for application #${input}, headless, on their machine. Run the REAL career-ops "pdf" mode — follow modes/pdf.md EXACTLY (do not improvise a format).
1. Read modes/pdf.md, cv.md, config/profile.yml, and the evaluation report at reports/${input}-*.md (for the JD keywords + analysis).
2. Tailor the CV per modes/pdf.md: inject the JD's keywords into the summary + first bullets, reorder experience by relevance, build the competency grid, pick the top 3–4 projects. NEVER invent skills — only reword REAL experience using the JD's vocabulary.
3. Fill templates/cv-template.html's {{...}} placeholders with the tailored content; write the HTML to /tmp/cv-{candidate}-{company}.html (candidate = the profile name in kebab-case).
4. Render the PDF: \`node generate-pdf.mjs /tmp/cv-{candidate}-{company}.html output/cv-{candidate}-{company}-${today}.pdf --format={letter for US/Canada companies, else a4}\`.
5. Update the tracker: in data/applications.md, change the PDF column for row #${input} from ❌ to ✅.
Do not submit anything anywhere.

End with EXACTLY one final line: VERDICT: {5 if the PDF was written, else 1}/5 — {the output/ path, ≤12 words}`;
  }
  if (kind === "fix-portal") {
    return `A company's job-portal ATS slug is BROKEN — career-ops can no longer scan it, so it silently disappears from every future scan. Repair it (headless, on the user's machine):
1. Run \`node verify-portals.mjs --add "${input}"\` — it probes Greenhouse/Ashby/Lever for the company's correct ATS slug and prints the suggested ats + slug.
2. Open portals.yml, find the "${input}" entry under tracked_companies, and update its careers_url (and any api/slug field) to the suggested WORKING ATS URL. Change ONLY this one company; preserve all other YAML structure, comments and formatting exactly.
3. Re-run \`node verify-portals.mjs\` and confirm "${input}" now shows ✅ live (not ❌).
If NO slug variant resolves, say so clearly and leave portals.yml unchanged. Never touch any other company.

End with EXACTLY one final line: VERDICT: {5 if now live, else 1}/5 — {what you changed, ≤12 words}`;
  }
  // evaluate (default) — run the REAL oferta mode + persist canonically
  return `You are running the OFFICIAL career-ops job evaluation, HEADLESS, on the user's own machine. Today is ${today}. Run the REAL career-ops evaluation — do NOT improvise your own scoring.

1. Read modes/offer.md and follow it EXACTLY (Decision Snapshot, blocks A-F, G posting-legitimacy, and the Machine Summary). Ground the fit in THIS person: read cv.md, config/profile.yml and modes/_profile.md. Use WebFetch to read the posting (you are headless — Playwright is unavailable, so use WebFetch and mark the report header "Verification: unconfirmed (batch mode)").

2. Persist the result CANONICALLY so the web and the CLI share ONE source of truth:
   a. Reserve a report number: run \`node reserve-report-num.mjs\` — its stdout is a 3-digit number (e.g. 035).
   b. Write the full report to reports/{num}-{company-slug}-${today}.md  (company-slug = company lowercased, non-alphanumerics → hyphens).
   c. Append ONE row of 9 TAB-separated columns to batch/tracker-additions/{num}-{company-slug}.tsv, in THIS exact order (real \\t tabs, status BEFORE score):
      {num}\t${today}\t{Company}\t{Role}\t{CanonicalStatus e.g. Evaluated}\t{score}/5\t❌\t[{num}](reports/{num}-{company-slug}-${today}.md)\t{one-line note}
   d. Merge into the tracker: run \`node merge-tracker.mjs\` (it dedupes by company+role+report-num, validates the status, and writes data/applications.md — NEVER edit applications.md by hand).

3. NEVER submit an application, fill no forms, contact no one. This is evaluation + persistence ONLY.${mem}

After everything above is written and merged, output EXACTLY one final line, nothing after it:
VERDICT: {score}/5 — {reason in 12 words or fewer}

Posting URL: ${input}`;
}

export async function POST(req: Request) {
  let body: {
    kind?: string;
    input?: string;
    cliId?: string;
    workerId?: string;
    resume?: boolean;
    continuation?: "retry" | "resume";
    title?: string;
    subtitle?: string;
    page?: string;
    batchId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input = "", cliId, workerId } = body;
  const continuation = body.continuation ?? (body.resume ? "resume" : null);
  if (body.continuation !== undefined && !["retry", "resume"].includes(body.continuation)) {
    return Response.json({ error: "invalid continuation" }, { status: 400 });
  }
  if (!cliId || (!input && !(kind === "lifecycle" && continuation))) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  if (!["evaluate", "research", "pdf", "fix-portal", "lifecycle"].includes(kind)) {
    return Response.json({ error: "unsupported run kind" }, { status: 400 });
  }

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsFiles: Record<string, string[]> = {
    evaluate: ["modes/offer.md"],
    "fix-portal": ["verify-portals.mjs"],
    pdf: ["generate-pdf.mjs"],
    lifecycle: ["opportunity-lifecycle.mjs", "modes/next.md", "config/profile.yml", "modes/_profile.md"],
  };
  const missingRequired = (needsFiles[kind] ?? []).find((required) => !fs.existsSync(path.join(careerOpsRoot(), required)));
  if (missingRequired) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${missingRequired}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "pdf" || kind === "lifecycle") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  let promptInput = input;
  let lifecycleWorkOrder: LifecycleWorkOrder | null = null;
  const durableWorkerId = workerId ?? `job-api-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  if (kind === "lifecycle") {
    if (!/^job-[a-z0-9-]{1,96}$/i.test(durableWorkerId) || (continuation && !workerId)) {
      return Response.json({ error: "valid workerId required" }, { status: 400 });
    }
    if (continuation) {
      const existing = readDurableWorker(careerOpsRoot(), durableWorkerId);
      const prior = existing?.recoveryHistory.at(-1);
      if (
        !existing
        || existing.status !== "terminal"
        || !prior
        || prior.nextAction.kind !== continuation
      ) {
        return Response.json({ error: "This worker cannot continue safely." }, { status: 409 });
      }
      try {
        const recoveryToken = acquireTrackerWrite();
        let currentRecovery;
        try {
          currentRecovery = await recoverLifecycleWork(careerOpsRoot(), existing.workOrder, {
            trigger: prior.outcome === "paused" ? "paused" : "reload",
          });
        } finally {
          releaseTrackerWrite(recoveryToken);
        }
        if (currentRecovery.nextAction.kind !== continuation) {
          settleDurableWorker(careerOpsRoot(), durableWorkerId, currentRecovery);
          return Response.json({ error: currentRecovery.message, code: currentRecovery.outcome, recovery: currentRecovery }, { status: 409 });
        }
        const current = (await readOpportunityLifecycle(careerOpsRoot(), existing.workOrder.opportunity)).opportunity;
        if (current.stage.id !== existing.workOrder.source.stage) {
          return Response.json({ error: "The Opportunity changed after this worker stopped.", code: "opportunity-conflict" }, { status: 409 });
        }
        if (current.stage.suggests !== existing.workOrder.action) {
          return Response.json({ error: "The canonical work action changed after this worker stopped.", code: "work-action-conflict" }, { status: 409 });
        }
        if (continuation === "resume") {
          lifecycleWorkOrder = {
            ...existing.workOrder,
            source: { stage: current.stage.id, revision: current.revision },
          };
        } else {
          const refreshed = await requestOpportunityWork(careerOpsRoot(), {
            opportunity: existing.workOrder.opportunity,
            expectedStage: current.stage.id,
            expectedRevision: current.revision,
          });
          if (!refreshed.workOrder || !["work-requested", "already-running"].includes(refreshed.code)) {
            return Response.json({ error: refreshed.message, code: refreshed.code, outcome: refreshed }, { status: refreshed.effect === "conflict" ? 409 : 422 });
          }
          if (refreshed.workOrder.id !== existing.workOrder.id || refreshed.workOrder.action !== existing.workOrder.action) {
            return Response.json({ error: "The canonical work action changed after this worker stopped.", code: "work-action-conflict" }, { status: 409 });
          }
          lifecycleWorkOrder = {
            ...refreshed.workOrder,
            source: { stage: current.stage.id, revision: current.revision },
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Lifecycle work could not be refreshed.";
        return Response.json(
          { error: message, code: error instanceof LifecycleAdapterError ? error.code : "lifecycle-refresh-failed" },
          { status: error instanceof LifecycleAdapterError ? error.status : 503 },
        );
      }
    } else {
      let expectation: { opportunity: number; expectedStage: string; expectedRevision: string };
      try {
        expectation = JSON.parse(input);
      } catch {
        return Response.json({ error: "invalid lifecycle expectation" }, { status: 400 });
      }
      const groupOwner = owningGroupForChild(careerOpsRoot(), durableWorkerId);
      if (
        (body.batchId && !ownsGroupChild(careerOpsRoot(), body.batchId, durableWorkerId, expectation.opportunity))
        || (!body.batchId && groupOwner)
        || (body.batchId && groupOwner?.id !== body.batchId)
      ) {
        return Response.json({ error: "This worker is not owned by the named work group.", code: "group-child-conflict" }, { status: 409 });
      }
      if (readDurableWorker(careerOpsRoot(), durableWorkerId)) {
        return Response.json({ error: "This durable worker already has canonical history.", code: "worker-history-exists" }, { status: 409 });
      }
      try {
        const outcome = await requestOpportunityWork(careerOpsRoot(), expectation);
        if (outcome.code !== "work-requested" || !outcome.workOrder) {
          const status = outcome.effect === "conflict" || outcome.code === "already-running" ? 409 : 422;
          return Response.json({ error: outcome.message, code: outcome.code, outcome }, { status });
        }
        lifecycleWorkOrder = outcome.workOrder;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Lifecycle work could not be requested.";
        return Response.json(
          { error: message, code: error instanceof LifecycleAdapterError ? error.code : "lifecycle-request-failed" },
          { status: error instanceof LifecycleAdapterError ? error.status : 503 },
        );
      }
    }
    if (!acquireWorker(durableWorkerId)) {
      return Response.json({ error: "Already running.", code: "already-running" }, { status: 409 });
    }
    try {
      if (continuation) {
        const continued = appendWorkerPhase(
          careerOpsRoot(),
          durableWorkerId,
          continuation === "resume" ? "resuming" : "retrying",
          continuation === "resume" ? "Resuming preserved work" : "Retrying work",
          lifecycleWorkOrder,
        );
        if (!continued) throw new Error("durable worker missing");
      } else {
        createDurableWorker(careerOpsRoot(), {
          id: durableWorkerId,
          title: body.title || `Prepare Opportunity #${lifecycleWorkOrder.opportunity}`,
          subtitle: body.subtitle,
          page: body.page,
          batchId: body.batchId,
          workOrder: lifecycleWorkOrder,
        });
      }
    } catch {
      releaseWorker(durableWorkerId);
      return Response.json({ error: "Durable worker state could not be initialized.", code: "worker-state-unavailable" }, { status: 503 });
    }
    promptInput = JSON.stringify(lifecycleWorkOrder);
  }
  const prompt = buildPrompt(kind, promptInput, readMemory(), today);

  const isClaude = cliId === "claude";
  // Tool scope by kind (comma-separated lists; disallowedTools is the hard
  // guardrail). 'evaluate' runs the REAL mode + persists canonical artifacts →
  // it needs Write + Bash (reserve-report-num / merge-tracker / write the
  // report). 'research' stays read-only. Task (sub-agents) is always blocked
  // (runaway cost). NEVER auto-submits — that is a prompt-level guarantee.
  const tools =
    kind === "evaluate" || kind === "fix-portal" || kind === "pdf" || kind === "lifecycle"
      ? { allowed: "Read,WebFetch,WebSearch,Write,Edit,Bash,Glob,Grep", disallowed: "Task,NotebookEdit" }
      : { allowed: "Read,WebFetch,WebSearch,Glob,Grep", disallowed: "Bash,Write,Edit,NotebookEdit,Task" };
  const args = isClaude
    ? ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
       "--permission-mode", "acceptEdits",
       "--allowedTools", tools.allowed,
       "--disallowedTools", tools.disallowed]
    : spec.args(prompt);

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const countReports = () => {
    try {
      return fs.readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length;
    } catch {
      return 0;
    }
  };
  const persists = kind === "evaluate";
  const reportsBefore = persists ? countReports() : 0;
  // Tracker-mutating runs hold a write token so a row delete can't race their merge
  // (tracker.mjs delete doesn't yet share a lock with merge-tracker — see run-registry).
  const writeToken = kind === "evaluate" || kind === "pdf" || kind === "lifecycle" ? acquireTrackerWrite() : null;

  const child = spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  const enc = new TextEncoder();

  // `closed` + kill timer in the OUTER scope so cancel() (client disconnect) can
  // flip `closed` before the child's late handlers run, and send() is try/catch'd —
  // otherwise a late enqueue onto a closed controller throws uncaught (see #1155).
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let resourcesReleased = false;
  let terminationTrigger: WorkRecoveryTrigger | null = null;
  const terminateChild = (trigger: WorkRecoveryTrigger) => {
    terminationTrigger = trigger;
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    if (escalation) clearTimeout(escalation);
    escalation = setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }, 5_000);
    escalation.unref?.();
  };
  const releaseResources = () => {
    if (resourcesReleased) return;
    resourcesReleased = true;
    if (writeToken !== null) releaseTrackerWrite(writeToken);
    if (kind === "lifecycle") releaseWorker(durableWorkerId);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buf = "";
      let emittedText = false; // any assistant text delta → the CLI actually ran
      let sawError = false;
      let lastTokens = 0; // per-run token cost from the Claude result event (#6) — local only
      let lastCostUsd: number | null = null;
      if (kind === "lifecycle" && lifecycleWorkOrder) {
        controller.enqueue(enc.encode(`${JSON.stringify({
          type: "identity",
          workerId: durableWorkerId,
          workOrder: lifecycleWorkOrder,
          label: continuation === "resume" ? "Resuming preserved work" : continuation === "retry" ? "Retrying work" : "Canonical work reserved",
        })}\n`));
      }
      // pdf-mode tailors a full CV + renders it — give it more headroom.
      const killMs = kind === "pdf" ? 720_000 : 285_000;
      killer = setTimeout(() => {
        terminateChild("timeout");
      }, killMs);
      const send = (obj: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + "\n")); } catch { closed = true; }
      };
      const close = () => {
        if (killer) clearTimeout(killer);
        if (escalation) clearTimeout(escalation);
        releaseResources();
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* */ }
      };

      child.stdout.on("data", (d: Buffer) => {
        if (closed) return;
        if (!isClaude) {
          emittedText = true;
          send({ type: "text", text: d.toString() });
          return;
        }
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stream_event") {
              const e = ev.event;
              if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
                send({ type: "tool", name: e.content_block.name });
                if (kind === "lifecycle") appendWorkerPhase(careerOpsRoot(), durableWorkerId, "tool", e.content_block.name);
              } else if (e?.type === "content_block_delta" && e.delta?.text) {
                emittedText = true;
                send({ type: "text", text: e.delta.text });
              }
            } else if (ev.type === "system" && ev.subtype === "init") {
              send({ type: "status", label: "Agent ready" });
              if (kind === "lifecycle") appendWorkerPhase(careerOpsRoot(), durableWorkerId, "agent-ready", "Agent ready");
            } else if (ev.type === "result") {
              // Capture the per-run cost; the authoritative "done" is sent on close
              // (so the honesty gate decides done-vs-error first). Tokens = the same
              // formula /api/usage uses: input + output + cache-creation.
              const u = ev.usage || {};
              lastTokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
              if (typeof ev.total_cost_usd === "number") lastCostUsd = ev.total_cost_usd;
            }
          } catch {
            /* partial line */
          }
        }
      });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        // Widened: auth/login/quota failures are the most common real error and
        // the old narrow regex missed them (silent false "success").
        if (/error|denied|fatal|not found|unauthorized|forbidden|auth|login|credential|api[ -]?key|quota|rate limit|capacity|not authenticated/i.test(s)) {
          sawError = true;
          if (/rate limit|capacity/i.test(s)) terminationTrigger = "paused";
          if (kind === "lifecycle") {
            appendWorkerPhase(careerOpsRoot(), durableWorkerId, "checking", "Checking canonical work after a process warning");
            send({ type: "status", label: "Checking canonical work" });
          } else {
            send({ type: "error", msg: s.trim().slice(0, 200) });
          }
        }
      });
      child.on("error", (e) => {
        terminationTrigger = "non-zero-exit";
        if (kind !== "lifecycle") send({ type: "error", msg: e.message });
      });
      child.on("close", async (code, signal) => {
        const wroteReport = countReports() > reportsBefore;
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        if (kind === "lifecycle" && lifecycleWorkOrder) {
          try {
            const trigger = terminationTrigger ?? (cleanExit && !sawError ? "completed" : "non-zero-exit");
            appendWorkerPhase(careerOpsRoot(), durableWorkerId, "reconciling", "Inspecting canonical artifact and lifecycle state");
            const recovery = await recoverLifecycleWork(careerOpsRoot(), lifecycleWorkOrder, {
              trigger,
              exitCode: code,
              signal: signal ? String(signal) : null,
              parserCode: emittedText ? null : "no-worker-output",
            });
            settleDurableWorker(careerOpsRoot(), durableWorkerId, recovery);
            send({ type: "terminal", recovery, tokens: lastTokens, costUsd: lastCostUsd });
          } catch {
            send({ type: "error", msg: "Canonical recovery state could not be persisted." });
          } finally {
            close();
          }
          return;
        }
        // Honesty gate (#9): a green "done" with a parsed score requires a CLEAN exit,
        // real output, AND (for evaluations) a report actually written. Anything else
        // is surfaced — an errored run must never be banked as a confident score.
        if (!emittedText && !sawError && !cleanExit) {
          send({ type: "error", msg: "The CLI exited with an error — is it installed and authenticated?" });
        } else if (!emittedText && !sawError) {
          send({ type: "error", msg: "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)" });
        } else if (persists && !wroteReport) {
          // The worker ran but never wrote the report/tracker row (e.g. a CLI
          // without file-write authorization) — surface it instead of a fake score.
          send({ type: "error", msg: "This evaluation didn't save a report, so it's not in your tracker. Full evaluation is verified on Claude Code." });
        } else if (!cleanExit || sawError) {
          // Produced output (maybe even a report) but did NOT finish cleanly — flag it
          // instead of recording a confident score off a half-finished run.
          send({ type: "error", msg: "This run hit an error before finishing, so it isn't recorded as a confident result — re-run it to verify." });
        } else {
          send({ type: "done", tokens: lastTokens, costUsd: lastCostUsd });
        }
        close();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      terminateChild("disconnect");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
