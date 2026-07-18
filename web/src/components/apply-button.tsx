"use client";

import { useRouter } from "next/navigation";
import { Send, Lock } from "lucide-react";
import { useApply } from "@/components/apply/apply-provider";

// The "Apply" CTA is enabled only by canonical accepted PDF evidence. A worker
// exit alone is insufficient because an inspectable overflow still needs review.
export function ApplyButton({ n, url, company, pdfReady }: { n: string; url?: string; company: string; pdfReady: boolean }) {
  const router = useRouter();
  const apply = useApply();

  const hasUrl = !!url && /^https?:\/\//i.test(url);
  const ready = pdfReady && hasUrl;

  if (!ready) {
    return (
      <button
        type="button"
        disabled
        title={!hasUrl ? "No application URL on this report" : "Generate the tailored CV (PDF) first to apply"}
        className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full border border-border bg-surface/40 px-3.5 py-1 text-xs font-medium text-faint max-sm:min-h-[44px]"
      >
        <Lock className="size-3.5" /> Apply
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        apply.open(url!, { prefill: true, company });
        router.push("/apply");
      }}
      className="inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-3.5 py-1 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
      title="Apply — opens the form pre-filled, you review and submit yourself"
    >
      <Send className="size-3.5" /> Apply
    </button>
  );
}
