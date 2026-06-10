/**
 * Unit tests for src/tools/review/grouping.ts
 * Run with: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { groupFilesIntoChunks, formatManifest } from "./grouping.js";
import type { ReviewManifest } from "./grouping.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChange(
  filePath: string,
  opts: {
    additions?: number;
    deletions?: number;
    newFile?: boolean;
    deletedFile?: boolean;
    renamedFile?: boolean;
  } = {}
) {
  const additions = opts.additions ?? 1;
  const deletions = opts.deletions ?? 0;

  // Build a minimal diff string matching the countChanges implementation
  const addLines = Array.from({ length: additions }, (_, i) => `+added line ${i}`).join("\n");
  const delLines = Array.from({ length: deletions }, (_, i) => `-removed line ${i}`).join("\n");
  const diff = [addLines, delLines].filter(Boolean).join("\n");

  return {
    oldPath: filePath,
    newPath: filePath,
    aMode: "100644",
    bMode: "100644",
    diff,
    newFile: opts.newFile ?? false,
    renamedFile: opts.renamedFile ?? false,
    deletedFile: opts.deletedFile ?? false,
  };
}

// ---------------------------------------------------------------------------
// groupFilesIntoChunks — config file separation
// ---------------------------------------------------------------------------
describe("groupFilesIntoChunks — config files", () => {
  test("package.json becomes part of config chunk", () => {
    const changes = [
      makeChange("package.json"),
      makeChange("src/index.ts"),
    ];
    const chunks = groupFilesIntoChunks(changes);
    const config = chunks.find((c) => c.chunkId === "config");
    assert.ok(config, "Expected a config chunk");
    assert.ok(config.files.includes("package.json"), JSON.stringify(config.files));
  });

  test("dotfile at root is a config file", () => {
    const changes = [makeChange(".eslintrc.json")];
    const chunks = groupFilesIntoChunks(changes);
    const config = chunks.find((c) => c.chunkId === "config");
    assert.ok(config, "Expected a config chunk for dotfile");
  });

  test("tsconfig.json is a config file", () => {
    const changes = [makeChange("tsconfig.json")];
    const chunks = groupFilesIntoChunks(changes);
    const config = chunks.find((c) => c.chunkId === "config");
    assert.ok(config);
  });

  test("config chunk groupName mentions file count", () => {
    const changes = [makeChange("package.json"), makeChange("tsconfig.json")];
    const chunks = groupFilesIntoChunks(changes);
    const config = chunks.find((c) => c.chunkId === "config");
    assert.ok(config?.groupName.includes("2"), config?.groupName);
  });

  test("src/ files are NOT in config chunk", () => {
    const changes = [makeChange("src/package.json")];
    const chunks = groupFilesIntoChunks(changes);
    const config = chunks.find((c) => c.chunkId === "config");
    // src/package.json is nested, so it should NOT be config
    assert.ok(!config, `Should not be config: ${JSON.stringify(chunks)}`);
  });
});

// ---------------------------------------------------------------------------
// groupFilesIntoChunks — directory grouping
// ---------------------------------------------------------------------------
describe("groupFilesIntoChunks — directory grouping", () => {
  test("files in same directory are grouped together", () => {
    const changes = [
      makeChange("src/api/client.ts"),
      makeChange("src/api/types.ts"),
      makeChange("src/api/errors.ts"),
    ];
    const chunks = groupFilesIntoChunks(changes);
    // All 3 are under src/api — should be in one chunk
    const apiChunk = chunks.find((c) => c.files.includes("src/api/client.ts"));
    assert.ok(apiChunk, "Expected a chunk for src/api/");
    assert.equal(apiChunk.files.length, 3);
  });

  test("files in different directories get separate chunks", () => {
    // Need enough files per group to avoid orphaning (groups.size <= 3 skips orphan logic)
    const changes = [
      makeChange("src/api/a.ts"),
      makeChange("src/api/b.ts"),
      makeChange("src/api/c.ts"),
      makeChange("src/tools/x.ts"),
      makeChange("src/tools/y.ts"),
      makeChange("src/tools/z.ts"),
    ];
    const chunks = groupFilesIntoChunks(changes);
    const apiChunk = chunks.find((c) => c.files.includes("src/api/a.ts"));
    const toolsChunk = chunks.find((c) => c.files.includes("src/tools/x.ts"));
    assert.ok(apiChunk, "Expected src/api chunk");
    assert.ok(toolsChunk, "Expected src/tools chunk");
    assert.notEqual(apiChunk.chunkId, toolsChunk.chunkId);
  });

  test("chunk groupName includes directory path and file count", () => {
    const changes = [
      makeChange("src/api/a.ts"),
      makeChange("src/api/b.ts"),
    ];
    // Only 1 group → groups.size === 1 (not >3), so no orphaning
    const chunks = groupFilesIntoChunks(changes);
    const chunk = chunks.find((c) => c.files.includes("src/api/a.ts"));
    assert.ok(chunk, JSON.stringify(chunks));
    assert.ok(chunk.groupName.includes("src/api"), chunk.groupName);
    assert.ok(chunk.groupName.includes("2"), chunk.groupName);
  });

  test("chunk totalAdditions and totalDeletions are summed correctly", () => {
    const changes = [
      makeChange("src/api/a.ts", { additions: 10, deletions: 5 }),
      makeChange("src/api/b.ts", { additions: 20, deletions: 3 }),
    ];
    const chunks = groupFilesIntoChunks(changes);
    const chunk = chunks.find((c) => c.files.includes("src/api/a.ts"));
    assert.ok(chunk);
    assert.equal(chunk.totalAdditions, 30);
    assert.equal(chunk.totalDeletions, 8);
  });
});

// ---------------------------------------------------------------------------
// groupFilesIntoChunks — large file gets its own chunk
// ---------------------------------------------------------------------------
describe("groupFilesIntoChunks — large file own chunk", () => {
  test("file with >500 changed lines gets its own chunk", () => {
    const changes = [
      makeChange("src/big.ts", { additions: 400, deletions: 200 }), // 600 total > 500
      makeChange("src/small.ts", { additions: 5 }),
    ];
    const chunks = groupFilesIntoChunks(changes);
    const bigChunk = chunks.find((c) => c.files.length === 1 && c.files[0] === "src/big.ts");
    assert.ok(bigChunk, `Expected dedicated chunk for big file. Got: ${JSON.stringify(chunks.map(c => c.chunkId))}`);
    assert.ok(bigChunk.groupName.includes("large file"), bigChunk.groupName);
  });

  test("file with exactly 500 changed lines is NOT its own chunk", () => {
    // Threshold is > 500, so exactly 500 should not trigger
    const changes = [
      makeChange("src/boundary.ts", { additions: 300, deletions: 200 }), // exactly 500
    ];
    const chunks = groupFilesIntoChunks(changes);
    const largeChunk = chunks.find((c) => c.groupName.includes("large file"));
    assert.ok(!largeChunk, "Exactly 500 should not be a large file chunk");
  });
});

// ---------------------------------------------------------------------------
// groupFilesIntoChunks — orphan grouping into misc
// ---------------------------------------------------------------------------
describe("groupFilesIntoChunks — orphan/misc grouping", () => {
  test("unique directories with 1-2 files are grouped into misc when >3 groups total", () => {
    // 5 unique directories, each with 1 file → all orphaned into misc
    const changes = [
      makeChange("alpha/a.ts"),
      makeChange("beta/b.ts"),
      makeChange("gamma/c.ts"),
      makeChange("delta/d.ts"),
      makeChange("epsilon/e.ts"),
    ];
    const chunks = groupFilesIntoChunks(changes);
    const misc = chunks.find((c) => c.chunkId === "misc");
    assert.ok(misc, `Expected misc chunk. Got: ${JSON.stringify(chunks.map(c => c.chunkId))}`);
    assert.equal(misc.files.length, 5);
  });

  test("misc chunk groupName mentions file count", () => {
    const changes = [
      makeChange("alpha/a.ts"),
      makeChange("beta/b.ts"),
      makeChange("gamma/c.ts"),
      makeChange("delta/d.ts"),
    ];
    const chunks = groupFilesIntoChunks(changes);
    const misc = chunks.find((c) => c.chunkId === "misc");
    assert.ok(misc);
    assert.ok(misc.groupName.includes("4"), misc.groupName);
  });

  test("no misc chunk when <= 3 groups total", () => {
    // Only 2 directories — orphan logic does NOT trigger (groups.size <= 3)
    const changes = [
      makeChange("src/a.ts"),
      makeChange("tests/b.ts"),
    ];
    const chunks = groupFilesIntoChunks(changes);
    const misc = chunks.find((c) => c.chunkId === "misc");
    // Both have 1 file each but only 2 groups → no orphaning
    assert.ok(!misc, `Should not have misc with only 2 groups. Got: ${JSON.stringify(chunks.map(c => c.chunkId))}`);
  });
});

// ---------------------------------------------------------------------------
// groupFilesIntoChunks — sub-grouping when >10 files
// ---------------------------------------------------------------------------
describe("groupFilesIntoChunks — sub-grouping for large groups", () => {
  test("group with >10 files is sub-grouped by next directory level", () => {
    // 11 files all in src/tools, some in src/tools/mr, some in src/tools/pr
    const changes = [
      makeChange("src/tools/mr/a.ts"),
      makeChange("src/tools/mr/b.ts"),
      makeChange("src/tools/mr/c.ts"),
      makeChange("src/tools/mr/d.ts"),
      makeChange("src/tools/mr/e.ts"),
      makeChange("src/tools/pr/a.ts"),
      makeChange("src/tools/pr/b.ts"),
      makeChange("src/tools/pr/c.ts"),
      makeChange("src/tools/pr/d.ts"),
      makeChange("src/tools/pr/e.ts"),
      makeChange("src/tools/pr/f.ts"),
    ];
    const chunks = groupFilesIntoChunks(changes);
    // Sub-groups should be created by src/tools/mr and src/tools/pr
    const mrChunk = chunks.find((c) => c.files.includes("src/tools/mr/a.ts"));
    const prChunk = chunks.find((c) => c.files.includes("src/tools/pr/a.ts"));
    assert.ok(mrChunk, `Expected src/tools/mr sub-chunk. Got: ${JSON.stringify(chunks.map(c => c.chunkId))}`);
    assert.ok(prChunk, `Expected src/tools/pr sub-chunk. Got: ${JSON.stringify(chunks.map(c => c.chunkId))}`);
    // They should be different chunks
    assert.notEqual(mrChunk.chunkId, prChunk.chunkId);
  });
});

// ---------------------------------------------------------------------------
// formatManifest
// ---------------------------------------------------------------------------
describe("formatManifest", () => {
  const manifest: ReviewManifest = {
    mrIid: 42,
    title: "Add feature X",
    sourceBranch: "feature/x",
    targetBranch: "main",
    author: "alice",
    totalFiles: 3,
    totalChunks: 2,
    chunks: [
      {
        chunkId: "src-api",
        groupName: "src/api/ (2 files)",
        files: ["src/api/a.ts", "src/api/b.ts"],
        totalAdditions: 10,
        totalDeletions: 5,
        estimatedTokens: 100,
      },
      {
        chunkId: "src-tools",
        groupName: "src/tools/ (1 file)",
        files: ["src/tools/x.ts"],
        totalAdditions: 20,
        totalDeletions: 0,
        estimatedTokens: 80,
      },
    ],
  };

  test("contains MR iid and title in header", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("!42"), result);
    assert.ok(result.includes("Add feature X"), result);
  });

  test("contains author and branches", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("@alice"), result);
    assert.ok(result.includes("feature/x"), result);
    assert.ok(result.includes("main"), result);
  });

  test("contains total files and chunks count", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("3 files"), result);
    assert.ok(result.includes("2 review chunks"), result);
  });

  test("lists each chunk with its ID", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("src-api"), result);
    assert.ok(result.includes("src-tools"), result);
  });

  test("lists chunk files", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("src/api/a.ts"), result);
    assert.ok(result.includes("src/tools/x.ts"), result);
  });

  test("includes additions/deletions per chunk", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("+10"), result);
    assert.ok(result.includes("-5"), result);
  });

  test("includes token estimate", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("100"), result);
  });

  test("includes overflowWarning when present", () => {
    const withWarning = { ...manifest, overflowWarning: "Too many files!" };
    const result = formatManifest(withWarning);
    assert.ok(result.includes("Too many files!"), result);
  });

  test("no WARNING line when overflowWarning absent", () => {
    const result = formatManifest(manifest);
    assert.ok(!result.includes("WARNING:"), result);
  });

  test("ends with instruction to call gitlab_get_review_chunk", () => {
    const result = formatManifest(manifest);
    assert.ok(result.includes("gitlab_get_review_chunk"), result);
  });
});
