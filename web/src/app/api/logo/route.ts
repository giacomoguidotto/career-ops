import { NextRequest } from "next/server";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCompanyLogo } from "@/lib/core/logo-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Localhost logo proxy + on-disk cache, FOREVER per key. Honors local-first: the
// browser never talks to Google directly. Accepts `?domain=` (exact) OR
// `?company=` (a name → we guess a handful of likely domains and resolve once).
// Persisted keys are fetched at most once, then served from .career-ops-web/logo-cache
// (a hit, or an empty sentinel for a known miss). On any miss → 404 so the
// client's <img onError> falls back to the offline monogram. Because the cache is
// keyed by company, once a company's logo resolves it's instant for that card AND
// every other card. Requests are cache-read-only unless an explicit interaction
// sends persist=1, so opening a passive surface never creates cache files.

function cacheDir(): string {
  return path.join(careerOpsRoot(), ".career-ops-web", "logo-cache");
}

function controlledLogoSource(): string | undefined {
  const raw = process.env.CAREER_OPS_LOGO_SOURCE_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return ["127.0.0.1", "::1", "localhost"].includes(url.hostname) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sameOriginPersistence(req: NextRequest): boolean {
  if (req.headers.get("sec-fetch-site") === "same-origin") return true;
  const referrer = req.headers.get("referer");
  if (!referrer) return false;
  try {
    return new URL(referrer).origin === req.nextUrl.origin;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const persistRequested = sp.get("persist") === "1";
  if (persistRequested && !sameOriginPersistence(req)) {
    return new Response("persistence requires a same-origin user action", { status: 403 });
  }
  const result = await resolveCompanyLogo({
    cacheDirectory: cacheDir(),
    domain: sp.get("domain") ?? "",
    company: sp.get("company") ?? "",
    persist: persistRequested,
    sourceUrl: controlledLogoSource(),
  });
  if (result.status !== 200) return new Response(result.message, { status: result.status });
  return new Response(result.bytes, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" },
  });
}
