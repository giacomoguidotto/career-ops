import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_FILTERS } from "./src/lib/explore.ts";
import { cleanupTempPortals, writeTempCompanyPortals, writeTempPortals } from "./src/lib/core/portals.ts";
import { runDiscovery } from "./src/lib/core/scan.ts";

const ORIGINAL_ROOT = process.env.CAREER_OPS_ROOT;

function script({ help = "--json", result = {}, legacy = "", requireArgs = [], helpMarker = "", structuredWithoutHelp = false, delayMs = 0 } = {}) {
  return [
    `import { appendFileSync } from "node:fs";`,
    structuredWithoutHelp ? `// Supports --json with capHit fields, but legacy help omits the flag.` : "",
    `const args = process.argv.slice(2);`,
    `if (args.includes("--help")) { ${helpMarker ? `appendFileSync(${JSON.stringify(helpMarker)}, "probe\\n");` : ""} process.stdout.write(${JSON.stringify(`${help}\n`)}); process.exit(0); }`,
    `const required = ${JSON.stringify(requireArgs)};`,
    `if (required.some((arg) => !args.includes(arg))) process.exit(9);`,
    delayMs ? `await new Promise((resolve) => setTimeout(resolve, ${delayMs}));` : "",
    help.includes("--json") || structuredWithoutHelp
      ? `process.stdout.write(${JSON.stringify(`${JSON.stringify(result)}\n`)});`
      : `process.stdout.write(${JSON.stringify(legacy)});`,
    "",
  ].join("\n");
}

function workspace(files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "career-ops-scanner-contract-"));
  mkdirSync(path.join(root, "data"), { recursive: true });
  writeFileSync(path.join(root, "portals.yml"), [
    "tracked_companies:",
    "  - name: Priority Fictional",
    "    careers_url: https://jobs.example.test/priority",
    "    scan_priority: 10",
    "title_filter:",
    "  positive: [engineer]",
    "",
  ].join("\n"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content);
  return root;
}

async function discover(root, filterOverrides = {}) {
  process.env.CAREER_OPS_ROOT = root;
  const events = [];
  const offers = await runDiscovery({ ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats], ...filterOverrides }, (event) => events.push(event));
  return {
    offers,
    events,
    summaries: Object.fromEntries(events.filter((event) => event.kind === "pathSummary").map((event) => [event.summary.path, event.summary])),
    errors: events.filter((event) => event.kind === "error"),
  };
}

function companyResult(overrides = {}) {
  return {
    contract: { id: "career-ops.scanner.company-first", version: 1 },
    ordering: { kind: "configured-priority", configuredSources: 1 },
    companiesAvailable: 4,
    companiesScanned: 4,
    jobBoardsAvailable: 1,
    jobBoardsScanned: 1,
    runCap: { limit: 30, deferred: 0 },
    companyCap: { limit: 3, deferred: 0 },
    unreachableTargets: 0,
    networkErrors: 0,
    otherErrors: 0,
    unhandledSources: 0,
    malformedSources: 0,
    offers: [],
    ...overrides,
  };
}

function reverseResult(overrides = {}) {
  return {
    contract: { id: "career-ops.scanner.reverse-ats", version: 1 },
    sources: ["greenhouse", "lever", "ashby", "workday"],
    sampling: "alphabetical",
    companyLimit: 150,
    companiesAvailable: 8,
    companiesScanned: 8,
    capHit: false,
    datasetStatus: { greenhouse: "ok", lever: "ok", ashby: "ok", workday: "ok" },
    postingsDroppedNoDate: 0,
    unreachableBoards: 0,
    sourceRecordsDropped: 0,
    offers: [],
    ...overrides,
  };
}

test.afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.CAREER_OPS_ROOT;
  else process.env.CAREER_OPS_ROOT = ORIGINAL_ROOT;
});

test("ephemeral scanner configs are owner-readable only", () => {
  const root = workspace();
  process.env.CAREER_OPS_ROOT = root;
  const files = [writeTempPortals(DEFAULT_FILTERS), writeTempCompanyPortals(DEFAULT_FILTERS)];
  try {
    for (const file of files) {
      assert.ok(file);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    for (const file of files) if (file) cleanupTempPortals(file);
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful structured capability probes are cached per scanner", async () => {
  const root = workspace();
  const companyMarker = path.join(root, "company-help.log");
  const reverseMarker = path.join(root, "reverse-help.log");
  writeFileSync(path.join(root, "scan.mjs"), script({ result: companyResult(), helpMarker: companyMarker }));
  writeFileSync(path.join(root, "scan-ats-full.mjs"), script({ result: reverseResult(), helpMarker: reverseMarker }));
  try {
    await discover(root);
    await discover(root);
    assert.equal(readFileSync(companyMarker, "utf8"), "probe\n");
    assert.equal(readFileSync(reverseMarker, "utf8"), "probe\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports company priority and caps plus reverse sampling and degradation", async () => {
  const shared = { company: "Shared Fictional", title: "Platform Engineer", url: "https://jobs.example.test/shared", location: "Remote", postedAt: "2026-07-18", source: "greenhouse-api" };
  const root = workspace({
    "scan.mjs": script({
      requireArgs: ["--dry-run", "--max-new=30", "--max-per-company=3", "--json"],
      result: companyResult({
        runCap: { limit: 30, deferred: 4 },
        companyCap: { limit: 3, deferred: 2 },
        offers: [shared, { company: "Priority Fictional", title: "AI Engineer", url: "https://jobs.example.test/company", source: "ashby-api" }],
      }),
    }),
    "scan-ats-full.mjs": script({
      requireArgs: ["--dry-run", "--since", "7", "--limit", "150", "--shuffle", "--json"],
      result: reverseResult({
        sampling: "shuffled",
        companiesAvailable: 20,
        companiesScanned: 8,
        capHit: true,
        datasetStatus: { greenhouse: "ok", lever: "stale", ashby: "empty", workday: "ok" },
        postingsDroppedNoDate: 3,
        unreachableBoards: 2,
        offers: [shared, { company: "Reverse Fictional", title: "ML Engineer", url: "https://jobs.example.test/reverse", source: "lever-full" }],
      }),
    }),
  });
  try {
    const result = await discover(root, { shuffleAts: true });
    assert.deepEqual(new Set(result.offers.map((offer) => offer.url)), new Set([
      "https://jobs.example.test/shared",
      "https://jobs.example.test/company",
      "https://jobs.example.test/reverse",
    ]));
    assert.equal(result.summaries["company-first"].ordering, "configured-priority");
    assert.deepEqual(result.summaries["company-first"].runCap, { limit: 30, deferred: 4 });
    assert.deepEqual(result.summaries["company-first"].companyCap, { limit: 3, deferred: 2 });
    assert.equal(result.summaries["company-first"].complete, false);
    assert.equal(result.summaries["reverse-ats"].sampling, "shuffled");
    assert.equal(result.summaries["reverse-ats"].capHit, true);
    assert.equal(result.summaries["reverse-ats"].datasetStatus.lever, "stale");
    assert.equal(result.summaries["reverse-ats"].unreachable, 2);
    assert.equal(result.summaries["reverse-ats"].droppedRecords, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishes each discovery path as soon as it settles", async () => {
  const companyOffer = { company: "Fast Fictional", title: "Platform Engineer", url: "https://jobs.example.test/fast", source: "ashby-api" };
  const reverseOffer = { company: "Slow Fictional", title: "Data Engineer", url: "https://jobs.example.test/slow", source: "lever-full" };
  const root = workspace({
    "scan.mjs": script({ result: companyResult({ offers: [companyOffer] }) }),
    "scan-ats-full.mjs": script({ delayMs: 150, result: reverseResult({ offers: [reverseOffer] }) }),
  });
  try {
    const result = await discover(root);
    const companySummary = result.events.findIndex((event) => event.kind === "pathSummary" && event.summary.path === "company-first");
    const reverseSummary = result.events.findIndex((event) => event.kind === "pathSummary" && event.summary.path === "reverse-ats");
    const companyPublished = result.events.findIndex((event) => event.kind === "offer" && event.offer.url === companyOffer.url);
    const reversePublished = result.events.findIndex((event) => event.kind === "offer" && event.offer.url === reverseOffer.url);
    assert.ok(companySummary >= 0 && companySummary < reverseSummary);
    assert.ok(companyPublished >= 0 && companyPublished < reversePublished);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean structured empty results are complete", async () => {
  const root = workspace({
    "scan.mjs": script({ result: companyResult() }),
    "scan-ats-full.mjs": script({ result: reverseResult() }),
  });
  try {
    const result = await discover(root);
    assert.equal(result.offers.length, 0);
    assert.equal(result.summaries["company-first"].complete, true);
    assert.equal(result.summaries["reverse-ats"].complete, true);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unhandled sources and malformed offers degrade only their affected path", async () => {
  const validCompany = { company: "Valid Company", title: "Platform Engineer", url: "https://jobs.example.test/valid-company", source: "ashby-api" };
  const validReverse = { company: "Valid Reverse", title: "Data Engineer", url: "https://jobs.example.test/valid-reverse", source: "lever-full" };
  const root = workspace({
    "scan.mjs": script({
      result: companyResult({
        companiesAvailable: 5,
        companiesScanned: 4,
        unhandledSources: 1,
        offers: [validCompany, { company: "Broken Company", title: "AI Engineer", url: "not-a-url" }],
      }),
    }),
    "scan-ats-full.mjs": script({
      result: reverseResult({ offers: [validReverse, { company: "Broken Reverse", title: "ML Engineer" }] }),
    }),
  });
  try {
    const result = await discover(root);
    assert.deepEqual(new Set(result.offers.map((offer) => offer.url)), new Set([validCompany.url, validReverse.url]));
    assert.equal(result.summaries["company-first"].unhandled, 1);
    assert.equal(result.summaries["company-first"].malformedRecords, 1);
    assert.equal(result.summaries["company-first"].complete, false);
    assert.equal(result.summaries["reverse-ats"].malformedRecords, 1);
    assert.equal(result.summaries["reverse-ats"].complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed configured source records prevent complete coverage claims", async () => {
  const root = workspace({
    "scan.mjs": script({ result: companyResult({ companiesAvailable: 5, companiesScanned: 4, malformedSources: 1 }) }),
    "scan-ats-full.mjs": script({ result: reverseResult({ companiesAvailable: 9, companiesScanned: 8, sourceRecordsDropped: 1 }) }),
  });
  try {
    const result = await discover(root);
    assert.equal(result.summaries["company-first"].malformedSources, 1);
    assert.equal(result.summaries["company-first"].complete, false);
    assert.equal(result.summaries["reverse-ats"].malformedSources, 1);
    assert.equal(result.summaries["reverse-ats"].complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy output renders without claiming completeness", async () => {
  const root = workspace({
    "scan.mjs": script({ help: "Usage: scan", legacy: "Companies scanned: 4\nNew offers added: 0\n" }),
    "scan-ats-full.mjs": script({
      help: "Usage: reverse scan",
      legacy: "Companies scanned: 8\nUnreachable boards: 0\n  + [lever-full] 2026-07-18 | Legacy Fictional | Data Engineer | Remote\n      https://jobs.example.test/legacy\n",
    }),
  });
  try {
    const result = await discover(root);
    assert.equal(result.offers.length, 1);
    assert.equal(result.summaries["company-first"].contract, "legacy");
    assert.equal(result.summaries["reverse-ats"].contract, "legacy");
    assert.equal(result.summaries["reverse-ats"].complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source contract fallback detects structured output omitted from legacy help", async () => {
  const root = workspace({
    "scan.mjs": script({ result: companyResult() }),
    "scan-ats-full.mjs": script({
      help: "Usage: reverse scan",
      structuredWithoutHelp: true,
      result: reverseResult({ contract: undefined, sources: undefined, sourceRecordsDropped: undefined, companiesAvailable: 12, companiesScanned: 8, capHit: true, postingsDroppedNoDate: 3 }),
    }),
  });
  try {
    const result = await discover(root);
    assert.equal(result.summaries["reverse-ats"].contract, "legacy");
    assert.equal(result.summaries["reverse-ats"].sampling, "alphabetical");
    assert.equal(result.summaries["reverse-ats"].capHit, true);
    assert.equal(result.summaries["reverse-ats"].droppedRecords, 3);
    assert.equal(result.summaries["reverse-ats"].complete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing, malformed, and unsupported paths degrade independently", async () => {
  const cases = [
    {
      name: "missing company entrypoint",
      files: { "scan-ats-full.mjs": script({ result: reverseResult() }) },
      unavailable: "company-first",
      available: "reverse-ats",
    },
    {
      name: "malformed reverse output",
      files: {
        "scan.mjs": script({ result: companyResult() }),
        "scan-ats-full.mjs": script({ result: reverseResult() }).replace(JSON.stringify(`${JSON.stringify(reverseResult())}\n`), JSON.stringify("not json\n")),
      },
      unavailable: "reverse-ats",
      available: "company-first",
    },
    {
      name: "unsupported company fields",
      files: {
        "scan.mjs": script({ result: { contract: { id: "career-ops.scanner.company-first", version: 1 }, offers: [] } }),
        "scan-ats-full.mjs": script({ result: reverseResult() }),
      },
      unavailable: "company-first",
      available: "reverse-ats",
    },
    {
      name: "inconsistent company counts",
      files: {
        "scan.mjs": script({ result: companyResult({ companiesAvailable: 3, companiesScanned: 4 }) }),
        "scan-ats-full.mjs": script({ result: reverseResult() }),
      },
      unavailable: "company-first",
      available: "reverse-ats",
    },
    {
      name: "reverse source mismatch",
      files: {
        "scan.mjs": script({ result: companyResult() }),
        "scan-ats-full.mjs": script({ result: reverseResult({ sources: ["greenhouse", "lever"] }) }),
      },
      unavailable: "reverse-ats",
      available: "company-first",
    },
  ];
  for (const item of cases) {
    const root = workspace(item.files);
    try {
      const result = await discover(root);
      assert.equal(result.summaries[item.unavailable].contract, "unavailable", item.name);
      assert.notEqual(result.summaries[item.available].contract, "unavailable", item.name);
      assert.equal(result.errors.length, 0, item.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("no entrypoints returns only content-safe diagnostics", async () => {
  const root = workspace();
  try {
    const result = await discover(root);
    assert.equal(result.summaries["company-first"].contract, "unavailable");
    assert.equal(result.summaries["reverse-ats"].contract, "unavailable");
    assert.equal(result.errors.length, 1);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
