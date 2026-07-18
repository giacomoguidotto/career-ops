import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCompanyLogo } from "./src/lib/core/logo-cache.ts";

test("a cache miss persists only after authorization and becomes a passive cache hit", async () => {
  const cacheDirectory = mkdtempSync(path.join(tmpdir(), "career-ops-logo-cache-"));
  const favicon = new Uint8Array(256).fill(7);
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return new Response(favicon, { status: 200, headers: { "Content-Type": "image/png" } });
  };

  try {
    const miss = await resolveCompanyLogo({
      cacheDirectory,
      domain: "example.com",
      persist: false,
      fetcher,
    });
    assert.equal(miss.status, 404);
    assert.equal(fetchCount, 0);
    assert.equal(existsSync(path.join(cacheDirectory, "example.com.png")), false);

    const persisted = await resolveCompanyLogo({
      cacheDirectory,
      domain: "example.com",
      persist: true,
      fetcher,
    });
    assert.equal(persisted.status, 200);
    assert.equal(fetchCount, 1);

    const passiveHit = await resolveCompanyLogo({
      cacheDirectory,
      domain: "example.com",
      persist: false,
      fetcher: async () => {
        throw new Error("a passive cache hit must not fetch");
      },
    });
    assert.equal(passiveHit.status, 200);
    assert.deepEqual(passiveHit.bytes, favicon);
    assert.equal(fetchCount, 1);
  } finally {
    rmSync(cacheDirectory, { recursive: true, force: true });
  }
});
