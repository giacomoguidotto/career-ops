"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, RefreshCcw } from "lucide-react";
import type { WorkRecovery } from "@/lib/core/work-recovery";

export function ResumeReconciliation({ opportunity, expectedStage, expectedRevision }: {
  opportunity: number;
  expectedStage: string;
  expectedRevision: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<WorkRecovery | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/opportunities/${opportunity}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedStage, expectedRevision }),
      });
      const value = await response.json();
      if (value.error && !value.recovery) throw new Error(value.error);
      if (!value.recovery) throw new Error("Canonical reconciliation did not complete.");
      setRecovery(value.recovery as WorkRecovery);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Canonical reconciliation did not complete.");
    } finally {
      setBusy(false);
    }
  };

  if (recovery) {
    return (
      <div>
        <p role="status" className="text-center text-[11px] text-muted">{recovery.message}</p>
        <button type="button" onClick={() => {
          router.refresh();
          if (recovery.nextAction.href) router.push(recovery.nextAction.href);
        }} className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand-200">
          {recovery.nextAction.label} <ArrowRight className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <button type="button" disabled={busy} onClick={resume} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-brand px-4 text-sm font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 disabled:opacity-55">
        {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCcw className="size-4" />}
        Resume reconciliation
      </button>
      {error && <p role="alert" className="mt-2 text-center text-[11px] text-rose-600 dark:text-rose-300">{error}</p>}
    </div>
  );
}
