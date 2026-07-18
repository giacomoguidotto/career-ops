import { LifecycleAdapterError } from "@/lib/core/opportunity-lifecycle";

export function lifecycleErrorResponse(error: unknown): Response {
  const failure = error instanceof LifecycleAdapterError
    ? error
    : new LifecycleAdapterError(
      "lifecycle-read-failed",
      "The passive lifecycle read could not be completed.",
      503,
    );
  return Response.json(
    { error: { code: failure.code, message: failure.message } },
    { status: failure.status },
  );
}
