import { Suspense } from "react";
import { pipelineSummary } from "@/lib/career-ops";
import { PipelineView } from "@/components/pipeline-view";

export const dynamic = "force-dynamic"; // always read fresh local files

export default async function PipelinePage() {
  const { inbox, lifecycle } = await pipelineSummary();
  return (
    <Suspense>
      <PipelineView lifecycle={lifecycle} inbox={inbox} />
    </Suspense>
  );
}
