import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_FILTERS } from "./src/lib/explore.ts";
import { runDiscovery } from "./src/lib/core/scan.ts";

const ORIGINAL_ROOT = process.env.CAREER_OPS_ROOT;

function script({ help = "--json", result = {}, legacy = "", requireArgs = [] } = {}) {
  return [
    `const args = process.argv.slice(2);`,
    `if (args.includes("--help")) { process.stdout.write(${JSON.stringify(`${help}\n`)}); process.exit(0); }`,
    `const required = ${JSON.stringify(requireArgs)};`,
    `if (required.some((arg) => !args.includes(arg))) process.exit(9);`,
    help.includes("--json")
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
    offers: [],
    ...overrides,
  };
}

function reverseResult(overrides = {}) {
  return {
    contract: { id: "career-ops.scanner.reverse-ats", version: 1 },
    sampling: "alphabetical",
    companyLimit: 150,
    companiesAvailable: 8,
    companiesScanned: 8,
    capHit: false,
    datasetStatus: { greenhouse: "ok", lever: "ok", ashby: "ok", workday: "ok" },
    postingsDroppedNoDate: 0,
    unreachableBoards: 0,
    offers: [],
    ...overrides,
  };
}

test.afterEach(() => {
  if (ORIGINAL_ROOT === undefined) delete process.env.CAREER_OPS_ROOT;
  else process.env.CAREER_OPS_ROOT = ORIGINAL_ROOT;
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
    assert.deepEqual(result.offers.map((offer) => offer.url), [
      "https://jobs.example.test/shared",
      "https://jobs.example.test/company",
      "https://jobs.example.test/reverse",
    ]);
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
