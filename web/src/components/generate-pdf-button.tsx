"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileDown, Loader2, FileText, RotateCcw } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { CostBadge } from "@/components/cost/cost-badge";

// Fires the real career-ops `pdf` mode. Readiness comes from canonical accepted
// PDF evidence, while a written overflow remains a separate review state.
type PdfReview = { actualPages: number; budget: number; trimGuidance: string; reviewRevision: string };

export function GeneratePdfButton({ n, company, pdfReady, pdfReview }: { n: string; company: string; pdfReady: boolean; pdfReview?: PdfReview }) {
  const { jobs, startJob, actOnJob, allowPdfOverflow } = useJobs();
  const router = useRouter();
  const [allowing, setAllowing] = useState(false);
  const [allowError, setAllowError] = useState("");
  const job = useMemo(
    () => jobs.filter((j) => j.kind === "pdf" && j.input === n).sort((a, b) => b.startedAt - a.startedAt)[0],
    [jobs, n],
  );
  const generate = () =>
    startJob({ title: `CV PDF · ${company}`, subtitle: "tailored for this role", kind: "pdf", input: n, page: `/pipeline/${n}` });
  const review = job?.recovery?.pdfReview ?? pdfReview;
  const regenerate = () => job?.recovery?.pdfReview ? actOnJob(job.id) : generate();
  const allow = () => {
    if (!review || allowing) return;
    if (job?.recovery?.pdfReview) {
      allowPdfOverflow(job.id);
      return;
    }
    setAllowing(true);
    setAllowError("");
    void fetch(`/api/opportunities/${n}/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "allow-page-count", expectedRevision: review.reviewRevision, pages: review.actualPages }),
    }).then(async (response) => {
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value?.message || value?.error?.message || "The page allowance was rejected.");
      router.refresh();
    }).catch((error) => setAllowError(error instanceof Error ? error.message : "The page allowance failed.")).finally(() => setAllowing(false));
  };

  if (job?.status === "running")
    return (
      <Link href={`/jobs/${job.id}`} className="inline-flex items-center justify-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3 py-1 text-xs font-medium text-brand max-sm:min-h-[44px]">
        <Loader2 className="size-3.5 animate-spin" /> Generating CV…
      </Link>
    );

  if (review)
    return (
      <div className="basis-full rounded-xl border border-amber-500/35 bg-amber-500/[0.07] p-4" role="status" aria-label="PDF needs review">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Written, not accepted</p>
            <p className="mt-1 text-xs text-muted">
              Actual: {review.actualPages} pages · Budget: {review.budget} {review.budget === 1 ? "page" : "pages"}
            </p>
          </div>
          <a href={`/api/cv-pdf?company=${encodeURIComponent(company)}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium hover:bg-surface-hover">
            <FileText className="size-3.5" /> Inspect overflow PDF
          </a>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">{review.trimGuidance}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={regenerate} className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-brand-foreground hover:bg-brand-200">
            <RotateCcw className="size-3.5" /> Regenerate after trimming
          </button>
          <button type="button" onClick={allow} disabled={allowing} className="inline-flex min-h-11 items-center rounded-md border border-amber-500/40 px-3 text-xs font-semibold text-amber-800 hover:bg-amber-500/10 disabled:cursor-wait disabled:opacity-60 dark:text-amber-200" title="Accept this exact page count and mark the PDF ready without trimming">
            {allowing ? "Allowing…" : `Allow this ${review.actualPages}-page count`}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-faint">Regeneration spends model tokens. Allowing accepts this exact written PDF and marks it ready.</p>
        {allowError && <p className="mt-2 text-xs text-red-600 dark:text-red-300">{allowError}</p>}
      </div>
    );

  const ready = pdfReady;
  if (ready)
    return (
      <span className="inline-flex items-center gap-1">
        <a
          href={`/api/cv-pdf?company=${encodeURIComponent(company)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]"
        >
          <FileText className="size-3.5" /> View tailored CV
        </a>
        <button
          onClick={generate}
          title="Regenerate the tailored CV"
          className="inline-flex items-center justify-center rounded-full p-1 text-faint transition-colors hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]"
        >
          <RotateCcw className="size-3" />
        </button>
      </span>
    );

  // Point-of-action cost affordance: generating a tailored CV runs the user's
  // AI (spends tokens). Surface it right on the trigger so cost is never a
  // surprise — the community's #1 pain (mirrors Explore's token-honesty).
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        onClick={generate}
        className="inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        title="Generate an ATS-optimized CV tailored to this role"
      >
        <FileDown className="size-3.5" /> Generate tailored CV (PDF)
      </button>
      <CostBadge kind="spend" size="xs" />
    </span>
  );
}
