import { spawn } from "node:child_process";
import fs from "node:fs";
import { careerOpsRoot, rootScript } from "../career-ops.ts";
import { cleanupTempPortals, writeTempCompanyPortals, writeTempPortals } from "./portals.ts";
import {
  ATS_SOURCES,
  type DiscoveredOffer,
  type DiscoveryPath,
  type ExploreFilters,
  type ScanEvent,
  type ScannerPathSummary,
} from "../explore.ts";

export type { DiscoveredOffer, ScanEvent, AtsSource } from "../explore.ts";
export { ATS_SOURCES } from "../explore.ts";

const OFFER_RE = /^\s*\+\s+\[([^\]]+)\]\s+(\S+)\s+\|\s+(.+)$/;
const ATS_START_RE = /⚙\s+(\S+)\s+—\s+(\d+)\s+companies/;
const PROGRESS_RE = /(\d+)\/(\d+)\s+scanned,\s+(\d+)\s+total matches/;
const ATS_DONE_RE = /done \((\d+) unreachable boards skipped\)/;
const COMPANIES_RE = /Companies scanned:\s+(\d+)/;
const UNREACHABLE_RE = /Unreachable boards:\s+(\d+)/;
const JSON_HELP_TIMEOUT_MS = 5_000;
const jsonSupportProbes = new Map<string, Promise<boolean>>();

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  failed: boolean;
};

type PathResult = { offers: DiscoveredOffer[]; summary: ScannerPathSummary };

type JsonOffer = {
  company?: unknown;
  title?: unknown;
  url?: unknown;
  location?: unknown;
  postedAt?: unknown;
  source?: unknown;
};

type CompanyJson = {
  contract?: { id?: unknown; version?: unknown };
  ordering?: { kind?: unknown; configuredSources?: unknown };
  companiesAvailable?: unknown;
  companiesScanned?: unknown;
  jobBoardsAvailable?: unknown;
  jobBoardsScanned?: unknown;
  runCap?: { limit?: unknown; deferred?: unknown };
  companyCap?: { limit?: unknown; deferred?: unknown };
  unreachableTargets?: unknown;
  networkErrors?: unknown;
  otherErrors?: unknown;
  unhandledSources?: unknown;
  malformedSources?: unknown;
  offers?: unknown;
};

type ReverseJson = {
  contract?: { id?: unknown; version?: unknown };
  sources?: unknown;
  sampling?: unknown;
  companyLimit?: unknown;
  companiesAvailable?: unknown;
  companiesScanned?: unknown;
  capHit?: unknown;
  datasetStatus?: unknown;
  postingsDroppedNoDate?: unknown;
  unreachableBoards?: unknown;
  sourceRecordsDropped?: unknown;
  offers?: unknown;
};

function safeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nullablePositiveInt(value: unknown): number | null | undefined {
  if (value === null) return null;
  const n = safeInt(value);
  return n !== null && n > 0 ? n : undefined;
}

function firstMatch(title: string, positives: string[]): string | undefined {
  const lower = title.toLowerCase();
  return positives.find((keyword) => keyword && lower.includes(keyword.toLowerCase()));
}

function normalizedOffer(raw: JsonOffer, filters: ExploreFilters): DiscoveredOffer | null {
  if (typeof raw.url !== "string" || typeof raw.company !== "string" || typeof raw.title !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw.url.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !raw.company.trim() || !raw.title.trim()) return null;
  const source = typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : "scanner";
  const postedAt = typeof raw.postedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.postedAt) ? raw.postedAt : "";
  return {
    url: raw.url.trim(),
    company: raw.company.trim(),
    title: raw.title.trim(),
    location: typeof raw.location === "string" ? raw.location.trim() : "",
    postedAt,
    source,
    ats: source.replace(/-(?:full|api)$/, ""),
    matchedKeyword: firstMatch(raw.title, filters.positive),
  };
}

function normalizedOffers(value: unknown, filters: ExploreFilters): { offers: DiscoveredOffer[]; dropped: number } | null {
  if (!Array.isArray(value)) return null;
  const offers = value.map((offer) => normalizedOffer((offer ?? {}) as JsonOffer, filters));
  return {
    offers: offers.filter((offer): offer is DiscoveredOffer => offer !== null),
    dropped: offers.filter((offer) => offer === null).length,
  };
}

function safeDatasetStatus(value: unknown): Record<string, "ok" | "stale" | "empty"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, status]) => status === "ok" || status === "stale" || status === "empty")) return null;
  return Object.fromEntries(entries) as Record<string, "ok" | "stale" | "empty">;
}

function unavailable(path: DiscoveryPath, diagnostic: string): PathResult {
  return {
    offers: [],
    summary: { path, contract: "unavailable", complete: false, searched: 0, unreachable: 0, diagnostic },
  };
}

function legacy(path: DiscoveryPath, offers: DiscoveredOffer[], searched: number, unreachable: number, details: Partial<ScannerPathSummary> = {}): PathResult {
  return {
    offers,
    summary: {
      path,
      contract: "legacy",
      ...details,
      complete: false,
      searched,
      unreachable,
      diagnostic: "Completeness details are unavailable for this scanner contract.",
    },
  };
}

function runCommand(script: string, args: string[], env: NodeJS.ProcessEnv, onLine?: (line: string) => void, timeoutMs = 230_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let failed = false;
    let settled = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(process.execPath, [script, ...args], {
      cwd: careerOpsRoot(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (killer) clearTimeout(killer);
      resolve({ stdout, stderr, code, failed });
    };
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString();
      if (next.length > 5_000_000) {
        failed = true;
        child.kill("SIGTERM");
        return current;
      }
      return next;
    };
    let lineBuffer = "";
    const progress = (chunk: Buffer) => {
      if (!onLine) return;
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
      progress(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
      progress(chunk);
    });
    child.once("error", () => {
      failed = true;
      finish(null);
    });
    child.once("close", (code) => {
      if (lineBuffer && onLine) onLine(lineBuffer);
      finish(code);
    });
    killer = setTimeout(() => {
      failed = true;
      child.kill("SIGTERM");
    }, timeoutMs);
  });
}

async function supportsJson(script: string): Promise<boolean> {
  const cached = jsonSupportProbes.get(script);
  if (cached) return cached;
  const pending = runCommand(script, ["--help"], { ...process.env }, undefined, JSON_HELP_TIMEOUT_MS).then((probe) => {
    const advertised = !probe.failed && probe.code === 0 && /(?:^|\s)--json(?:\s|$)/m.test(`${probe.stdout}\n${probe.stderr}`);
    let sourceContract = false;
    if (!advertised) {
      try {
        const source = fs.readFileSync(script, "utf8");
        sourceContract = source.includes("--json") && (source.includes("career-ops.scanner.") || source.includes("capHit"));
      } catch {
        sourceContract = false;
      }
    }
    const supported = advertised || sourceContract;
    if (!supported) jsonSupportProbes.delete(script);
    return supported;
  });
  jsonSupportProbes.set(script, pending);
  return pending;
}

/** Compatibility probe retained for structural diagnostics. It executes the
 * exact reverse scanner help command and checks the requested feature flag. */
export async function scannerSupportsJson(): Promise<boolean> {
  const script = rootScript("scan-ats-full");
  return fs.existsSync(script) && supportsJson(script);
}

function progressEmitter(onEvent: (event: ScanEvent) => void): (line: string) => void {
  let currentAts = "";
  return (line) => {
    const ats = line.match(ATS_START_RE);
    if (ats) {
      currentAts = ats[1];
      onEvent({ kind: "atsStart", ats: ats[1], companies: Number(ats[2]) });
      return;
    }
    const progress = line.match(PROGRESS_RE);
    if (progress) {
      onEvent({ kind: "progress", ats: currentAts, scanned: Number(progress[1]), total: Number(progress[2]), matches: Number(progress[3]) });
      return;
    }
    const done = line.match(ATS_DONE_RE);
    if (done) onEvent({ kind: "atsDone", ats: currentAts, unreachable: Number(done[1]) });
  };
}

function parseLegacyReverse(stdout: string, filters: ExploreFilters): PathResult {
  const offers: DiscoveredOffer[] = [];
  const seen = new Set<string>();
  let pending: Omit<DiscoveredOffer, "url"> | null = null;
  let searched = 0;
  let unreachable = 0;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (pending && /^https?:\/\//i.test(trimmed)) {
      const rawUrl = trimmed.split(/\s+/)[0];
      const offer = normalizedOffer({ ...pending, url: rawUrl }, filters);
      if (offer && !seen.has(offer.url)) {
        seen.add(offer.url);
        offers.push(offer);
      }
      pending = null;
      continue;
    }
    if (pending) pending = null;
    const match = line.match(OFFER_RE);
    if (match) {
      const fields = match[3].split(" | ");
      if (fields.length >= 2) {
        const source = match[1];
        pending = {
          company: fields[0].trim(),
          title: fields[1].trim(),
          location: fields.slice(2).join(" | ").trim().replace(/^N\/A$/, ""),
          postedAt: /^\d{4}-\d{2}-\d{2}$/.test(match[2]) ? match[2] : "",
          source,
          ats: source.replace(/-full$/, ""),
          matchedKeyword: firstMatch(fields[1], filters.positive),
        };
      }
    }
    const companies = line.match(COMPANIES_RE);
    if (companies) searched = Number(companies[1]);
    const unreachableMatch = line.match(UNREACHABLE_RE);
    if (unreachableMatch) unreachable = Number(unreachableMatch[1]);
  }
  return legacy("reverse-ats", offers, searched, unreachable);
}

function parseCompanyJson(raw: CompanyJson, filters: ExploreFilters): PathResult | null {
  const normalized = normalizedOffers(raw.offers, filters);
  if (!normalized) return null;
  const searchedCompanies = safeInt(raw.companiesScanned);
  const searchedBoards = safeInt(raw.jobBoardsScanned);
  const availableCompanies = safeInt(raw.companiesAvailable);
  const availableBoards = safeInt(raw.jobBoardsAvailable);
  const runLimit = nullablePositiveInt(raw.runCap?.limit);
  const companyLimit = nullablePositiveInt(raw.companyCap?.limit);
  const runDeferred = safeInt(raw.runCap?.deferred);
  const companyDeferred = safeInt(raw.companyCap?.deferred);
  const unreachable = safeInt(raw.unreachableTargets);
  const network = safeInt(raw.networkErrors);
  const other = safeInt(raw.otherErrors);
  const unhandled = safeInt(raw.unhandledSources);
  const malformedSources = safeInt(raw.malformedSources);
  const configured = safeInt(raw.ordering?.configuredSources);
  const structured = raw.contract?.id === "career-ops.scanner.company-first"
    && raw.contract.version === 1
    && raw.ordering?.kind === "configured-priority"
    && searchedCompanies !== null && searchedBoards !== null
    && availableCompanies !== null && availableBoards !== null
    && runLimit !== undefined && companyLimit !== undefined
    && runDeferred !== null && companyDeferred !== null
    && unreachable !== null && network !== null && other !== null && unhandled !== null && malformedSources !== null && configured !== null;
  if (!structured) {
    return raw.contract === undefined
      ? legacy("company-first", normalized.offers, searchedCompanies ?? 0, unreachable ?? 0)
      : null;
  }
  const failures = unreachable + network + other;
  const searched = searchedCompanies + searchedBoards;
  const available = availableCompanies + availableBoards;
  if (searched > available || configured > searched || unhandled + malformedSources > available - searched) return null;
  return {
    offers: normalized.offers,
    summary: {
      path: "company-first",
      contract: "structured",
      complete: searched === available && runDeferred === 0 && companyDeferred === 0 && failures === 0 && unhandled === 0 && malformedSources === 0 && normalized.dropped === 0,
      searched,
      available,
      unreachable: failures,
      unhandled,
      malformedSources,
      malformedRecords: normalized.dropped,
      ordering: "configured-priority",
      configuredPrioritySources: configured,
      runCap: { limit: runLimit, deferred: runDeferred },
      companyCap: { limit: companyLimit, deferred: companyDeferred },
    },
  };
}

function parseReverseJson(raw: ReverseJson, filters: ExploreFilters): PathResult | null {
  const normalized = normalizedOffers(raw.offers, filters);
  if (!normalized) return null;
  const searched = safeInt(raw.companiesScanned);
  const available = safeInt(raw.companiesAvailable);
  const unreachable = safeInt(raw.unreachableBoards);
  const dropped = safeInt(raw.postingsDroppedNoDate);
  const malformedSources = safeInt(raw.sourceRecordsDropped);
  const datasetStatus = safeDatasetStatus(raw.datasetStatus);
  const expectedSources = filters.ats.length ? filters.ats : [...ATS_SOURCES];
  const sources = Array.isArray(raw.sources) && raw.sources.every((source) => typeof source === "string") ? raw.sources : null;
  const companyLimit = nullablePositiveInt(raw.companyLimit);
  const sampling = raw.sampling === "alphabetical" || raw.sampling === "shuffled" ? raw.sampling : null;
  const capHit = typeof raw.capHit === "boolean" ? raw.capHit : null;
  const structured = raw.contract?.id === "career-ops.scanner.reverse-ats"
    && raw.contract.version === 1
    && sampling !== null
    && capHit !== null
    && searched !== null && available !== null && unreachable !== null && dropped !== null && malformedSources !== null
    && datasetStatus !== null && companyLimit !== undefined;
  if (!structured) {
    if (raw.contract !== undefined) return null;
    const legacyDetails: Partial<ScannerPathSummary> = sampling !== null && capHit !== null && available !== null && dropped !== null && datasetStatus !== null && companyLimit !== undefined
      ? {
          available,
          sampling,
          capHit,
          datasetStatus,
          droppedRecords: dropped,
          malformedRecords: normalized.dropped,
          companyCap: { limit: companyLimit, deferred: Math.max(0, available - (searched ?? 0)) },
        }
      : {};
    return legacy("reverse-ats", normalized.offers, searched ?? 0, unreachable ?? 0, legacyDetails);
  }
  if (sources === null
    || sources.length !== expectedSources.length
    || sources.some((source, index) => source !== expectedSources[index])
    || Object.keys(datasetStatus).length !== expectedSources.length
    || expectedSources.some((source) => !(source in datasetStatus))
    || searched > available
    || malformedSources > available - searched) return null;
  const datasetIssue = Object.values(datasetStatus).some((status) => status !== "ok");
  return {
    offers: normalized.offers,
    summary: {
      path: "reverse-ats",
      contract: "structured",
      complete: searched === available && !capHit && !datasetIssue && unreachable === 0 && dropped === 0 && malformedSources === 0 && normalized.dropped === 0,
      searched,
      available,
      unreachable,
      sampling,
      capHit,
      datasetStatus,
      droppedRecords: dropped,
      malformedSources,
      malformedRecords: normalized.dropped,
      companyCap: { limit: companyLimit, deferred: Math.max(0, available - searched) },
    },
  };
}

async function runCompanyFirst(filters: ExploreFilters, onEvent: (event: ScanEvent) => void): Promise<PathResult> {
  const path: DiscoveryPath = "company-first";
  const script = rootScript("scan");
  if (!fs.existsSync(script)) return unavailable(path, "The tracked-company scanner entrypoint is unavailable.");
  let tempPortals: string | null;
  try {
    tempPortals = writeTempCompanyPortals(filters);
  } catch {
    return unavailable(path, "The tracked-company scanner configuration could not be prepared.");
  }
  if (!tempPortals) return unavailable(path, "Tracked-company discovery needs a readable portals.yml.");
  onEvent({ kind: "pathStart", path });
  try {
    const structured = await supportsJson(script);
    const args = [
      "--dry-run",
      `--max-new=${filters.companyRunLimit}`,
      `--max-per-company=${filters.companyOfferLimit}`,
      ...(structured ? ["--json"] : []),
    ];
    const result = await runCommand(script, args, { ...process.env, CAREER_OPS_PORTALS: tempPortals });
    if (result.failed || result.code !== 0) return unavailable(path, "The tracked-company scanner did not complete successfully.");
    if (!structured) {
      const searched = Number(result.stdout.match(COMPANIES_RE)?.[1] ?? 0);
      return legacy(path, [], searched, 0);
    }
    let json: CompanyJson;
    try {
      json = JSON.parse(result.stdout.trim()) as CompanyJson;
    } catch {
      return unavailable(path, "The tracked-company scanner returned malformed structured output.");
    }
    return parseCompanyJson(json, filters) ?? unavailable(path, "The tracked-company scanner returned unsupported structured fields.");
  } finally {
    cleanupTempPortals(tempPortals);
  }
}

async function runReverseAts(filters: ExploreFilters, onEvent: (event: ScanEvent) => void): Promise<PathResult> {
  const path: DiscoveryPath = "reverse-ats";
  const script = rootScript("scan-ats-full");
  if (!fs.existsSync(script)) return unavailable(path, "The reverse-ATS scanner entrypoint is unavailable.");
  let tempPortals: string;
  try {
    tempPortals = writeTempPortals(filters);
  } catch {
    return unavailable(path, "The reverse-ATS scanner configuration could not be prepared.");
  }
  onEvent({ kind: "pathStart", path });
  try {
    const structured = await supportsJson(script);
    const args = [
      "--dry-run",
      "--since", String(Math.max(1, filters.sinceDays || 7)),
      "--ats", (filters.ats.length ? filters.ats : [...ATS_SOURCES]).join(","),
      "--limit", String(Math.max(1, filters.limitPerAts || 150)),
      ...(filters.shuffleAts ? ["--shuffle"] : []),
      ...(structured ? ["--json"] : []),
    ];
    const result = await runCommand(script, args, { ...process.env, CAREER_OPS_PORTALS: tempPortals }, progressEmitter(onEvent));
    if (result.failed || result.code !== 0) return unavailable(path, "The reverse-ATS scanner did not complete successfully.");
    if (!structured) return parseLegacyReverse(result.stdout, filters);
    let json: ReverseJson;
    try {
      json = JSON.parse(result.stdout.trim()) as ReverseJson;
    } catch {
      return unavailable(path, "The reverse-ATS scanner returned malformed structured output.");
    }
    return parseReverseJson(json, filters) ?? unavailable(path, "The reverse-ATS scanner returned unsupported structured fields.");
  } finally {
    cleanupTempPortals(tempPortals);
  }
}

/** Run both canonical discovery paths independently. One missing or incompatible
 * scanner never disables the other, and all visible completeness claims come
 * from the exact command's structured fields rather than a product version. */
export async function runDiscovery(filters: ExploreFilters, onEvent: (event: ScanEvent) => void): Promise<DiscoveredOffer[]> {
  const offers: DiscoveredOffer[] = [];
  const seen = new Set<string>();
  const publish = async (pending: Promise<PathResult>): Promise<PathResult> => {
    const result = await pending;
    onEvent({ kind: "pathSummary", summary: result.summary });
    for (const offer of result.offers) {
      if (seen.has(offer.url)) continue;
      seen.add(offer.url);
      offers.push(offer);
      onEvent({ kind: "offer", offer });
    }
    return result;
  };
  const [company, reverse] = await Promise.all([
    publish(runCompanyFirst(filters, onEvent)),
    publish(runReverseAts(filters, onEvent)),
  ]);
  if (company.summary.contract === "unavailable" && reverse.summary.contract === "unavailable") {
    onEvent({ kind: "error", message: "No compatible discovery scanner is available in this checkout." });
  }
  return offers;
}
