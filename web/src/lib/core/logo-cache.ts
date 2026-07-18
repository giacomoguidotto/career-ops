import fs from "node:fs/promises";
import path from "node:path";

const DOMAIN_RE = /^[a-z0-9.-]{1,253}\.[a-z]{2,}$/i;

type Fetcher = typeof fetch;

export type CompanyLogoResult =
  | { status: 200; bytes: Uint8Array<ArrayBuffer> }
  | { status: 400 | 404; message: string };

/** Plausible domains for a company name, cheapest/likeliest first. */
function companyDomains(company: string): string[] {
  const paren = company.match(/\(([A-Za-z0-9]{2,12})\)/)?.[1];
  const base = company.replace(/\([^()]*\)/g, "").trim();
  const compact = base.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  const firstWord = base.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
  const stems = [...new Set([compact, paren?.toLowerCase(), firstWord]
    .filter((stem): stem is string => typeof stem === "string" && stem.length >= 2 && stem.length <= 30))];
  const domains: string[] = [];
  for (const suffix of [".com", ".ai", ".io", ".co"]) {
    for (const stem of stems) domains.push(stem + suffix);
  }
  return domains.slice(0, 5);
}

async function fetchFavicon(domain: string, fetcher: Fetcher): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const response = await fetcher(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`, {
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(3500),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > 220 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Resolve one company logo through a cache-first contract. Cache misses are
 * read-only unless the caller carries explicit user authorization (`persist`).
 */
export async function resolveCompanyLogo({
  cacheDirectory,
  domain = "",
  company = "",
  persist = false,
  fetcher = fetch,
}: {
  cacheDirectory: string;
  domain?: string;
  company?: string;
  persist?: boolean;
  fetcher?: Fetcher;
}): Promise<CompanyLogoResult> {
  const normalizedDomain = domain.trim().toLowerCase();
  const normalizedCompany = company.trim();

  let key: string;
  let candidates: string[];
  if (normalizedDomain) {
    if (!DOMAIN_RE.test(normalizedDomain) || normalizedDomain.includes("..")) {
      return { status: 400, message: "bad domain" };
    }
    key = normalizedDomain.replace(/[^a-z0-9.-]/g, "_");
    candidates = [normalizedDomain];
  } else if (normalizedCompany) {
    const slug = normalizedCompany.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
    if (!slug) return { status: 400, message: "bad company" };
    key = `co_${slug}`;
    candidates = companyDomains(normalizedCompany);
    if (candidates.length === 0) return { status: 404, message: "no logo" };
  } else {
    return { status: 400, message: "need domain or company" };
  }

  const resolvedCacheDirectory = path.resolve(cacheDirectory);
  const file = path.resolve(resolvedCacheDirectory, `${key}.png`);
  if (!file.startsWith(resolvedCacheDirectory + path.sep)) {
    return { status: 400, message: "bad key" };
  }

  try {
    const bytes = await fs.readFile(file);
    if (bytes.byteLength > 0) return { status: 200, bytes: Uint8Array.from(bytes) };
    return { status: 404, message: "no logo" };
  } catch {
    // A passive cache miss must not resolve externally or write a sentinel.
  }

  if (!persist) return { status: 404, message: "no logo" };

  let bytes: Uint8Array<ArrayBuffer> | null = null;
  for (const candidate of candidates) {
    bytes = await fetchFavicon(candidate, fetcher);
    if (bytes) break;
  }

  try {
    await fs.mkdir(resolvedCacheDirectory, { recursive: true });
    await fs.writeFile(file, bytes ?? new Uint8Array(0));
  } catch {
    // Cache persistence is best-effort; the fetched response can still render.
  }

  return bytes ? { status: 200, bytes } : { status: 404, message: "no logo" };
}
