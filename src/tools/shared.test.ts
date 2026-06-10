/**
 * Unit tests for src/tools/shared.ts pure helpers.
 * Run with: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  textResult,
  fileStatusLetter,
  fileStatusLabel,
  formatPositionRef,
  formatDuration,
  formatBytes,
  isDiscussionResolved,
  formatMergeRequest,
  formatCommit,
  formatDiscussion,
} from "./shared.js";

// ---------------------------------------------------------------------------
// textResult
// ---------------------------------------------------------------------------
describe("textResult", () => {
  test("string input produces correct shape", () => {
    const result = textResult("hello");
    assert.deepEqual(result, {
      content: [{ type: "text", text: "hello" }],
    });
  });

  test("array input is joined with newlines", () => {
    const result = textResult(["a", "b", "c"]);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "a\nb\nc" }],
    });
  });

  test("empty array produces empty string", () => {
    const result = textResult([]);
    assert.deepEqual(result, { content: [{ type: "text", text: "" }] });
  });

  test("single-element array has no trailing newline", () => {
    const result = textResult(["only"]);
    assert.equal(result.content[0].text, "only");
  });
});

// ---------------------------------------------------------------------------
// fileStatusLetter
// ---------------------------------------------------------------------------
describe("fileStatusLetter", () => {
  test("newFile → A", () => {
    assert.equal(fileStatusLetter({ newFile: true }), "A");
  });

  test("deletedFile → D", () => {
    assert.equal(fileStatusLetter({ deletedFile: true }), "D");
  });

  test("renamedFile → R", () => {
    assert.equal(fileStatusLetter({ renamedFile: true }), "R");
  });

  test("no flags → M", () => {
    assert.equal(fileStatusLetter({}), "M");
  });

  test("newFile takes precedence over renamedFile", () => {
    assert.equal(fileStatusLetter({ newFile: true, renamedFile: true }), "A");
  });

  test("newFile takes precedence over deletedFile", () => {
    assert.equal(fileStatusLetter({ newFile: true, deletedFile: true }), "A");
  });

  test("deletedFile takes precedence over renamedFile", () => {
    assert.equal(
      fileStatusLetter({ deletedFile: true, renamedFile: true }),
      "D"
    );
  });
});

// ---------------------------------------------------------------------------
// fileStatusLabel
// ---------------------------------------------------------------------------
describe("fileStatusLabel", () => {
  test("newFile → Added", () => {
    assert.equal(fileStatusLabel({ newFile: true }), "Added");
  });

  test("deletedFile → Deleted", () => {
    assert.equal(fileStatusLabel({ deletedFile: true }), "Deleted");
  });

  test("renamedFile → Renamed", () => {
    assert.equal(fileStatusLabel({ renamedFile: true }), "Renamed");
  });

  test("no flags → Modified", () => {
    assert.equal(fileStatusLabel({}), "Modified");
  });

  test("newFile + renamedFile → Added (precedence)", () => {
    assert.equal(fileStatusLabel({ newFile: true, renamedFile: true }), "Added");
  });
});

// ---------------------------------------------------------------------------
// formatPositionRef
// ---------------------------------------------------------------------------
describe("formatPositionRef", () => {
  test("newPath + newLine → path:line", () => {
    assert.equal(
      formatPositionRef({ newPath: "src/foo.ts", newLine: 42 }),
      "src/foo.ts:42"
    );
  });

  test("falls back to oldPath when newPath is null", () => {
    assert.equal(
      formatPositionRef({ newPath: null, oldPath: "src/old.ts", newLine: 5 }),
      "src/old.ts:5"
    );
  });

  test("falls back to oldLine when newLine is null", () => {
    assert.equal(
      formatPositionRef({ newPath: "f.ts", newLine: null, oldLine: 7 }),
      "f.ts:7"
    );
  });

  test("uses ? for missing file", () => {
    assert.equal(
      formatPositionRef({ newPath: null, oldPath: null, newLine: 1 }),
      "?:1"
    );
  });

  test("uses ? for missing line", () => {
    assert.equal(
      formatPositionRef({ newPath: "f.ts", newLine: null, oldLine: null }),
      "f.ts:?"
    );
  });

  test("null input → empty string", () => {
    assert.equal(formatPositionRef(null), "");
  });

  test("undefined input → empty string", () => {
    assert.equal(formatPositionRef(undefined), "");
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------
describe("formatDuration", () => {
  test("falsy (0) returns default fallback N/A", () => {
    assert.equal(formatDuration(0), "N/A");
  });

  test("null returns default fallback N/A", () => {
    assert.equal(formatDuration(null), "N/A");
  });

  test("undefined returns default fallback N/A", () => {
    assert.equal(formatDuration(undefined), "N/A");
  });

  test("custom fallback is used when seconds is falsy", () => {
    assert.equal(formatDuration(undefined, "-"), "-");
    assert.equal(formatDuration(0, "-"), "-");
  });

  test("< 60 seconds returns Ys (Math.round)", () => {
    assert.equal(formatDuration(30), "30s");
    assert.equal(formatDuration(30.4), "30s");
    assert.equal(formatDuration(30.6), "31s");
    assert.equal(formatDuration(59), "59s");
    assert.equal(formatDuration(1), "1s");
  });

  test(">= 60 seconds returns Xm Ys format", () => {
    assert.equal(formatDuration(60), "1m 0s");
    assert.equal(formatDuration(90), "1m 30s");
    assert.equal(formatDuration(120), "2m 0s");
    // 125 => floor(125/60)=2m, round(125%60)=round(5)=5s
    assert.equal(formatDuration(125), "2m 5s");
    // 3661 => floor(3661/60)=61m, round(3661%60)=round(1)=1s
    assert.equal(formatDuration(3661), "61m 1s");
  });

  test("seconds with rounding boundary: 59.5 rounds to 60s (< 60 path) → '60s'", () => {
    // 59.5 < 60 so takes Math.round path: Math.round(59.5) = 60
    assert.equal(formatDuration(59.5), "60s");
  });
});

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------
describe("formatBytes", () => {
  test("< 1 MiB returns KB with 1 decimal", () => {
    // 1024 bytes = 1.0 KB
    assert.equal(formatBytes(1024), "1.0KB");
  });

  test("512 bytes = 0.5KB", () => {
    assert.equal(formatBytes(512), "0.5KB");
  });

  test("exactly 1 MiB (1024*1024) → KB because condition is strictly >", () => {
    // formatBytes uses bytes > 1024*1024 (strictly greater), so 1 MiB itself → KB path
    // 1024*1024 / 1024 = 1024.0 KB
    assert.equal(formatBytes(1024 * 1024), "1024.0KB");
  });

  test("1.5 MiB returns MB", () => {
    const bytes = Math.round(1.5 * 1024 * 1024);
    assert.equal(formatBytes(bytes), "1.5MB");
  });

  test("10 MiB returns MB with 1 decimal", () => {
    assert.equal(formatBytes(10 * 1024 * 1024), "10.0MB");
  });
});

// ---------------------------------------------------------------------------
// isDiscussionResolved
// ---------------------------------------------------------------------------
describe("isDiscussionResolved", () => {
  test("zero resolvable notes → false", () => {
    assert.equal(
      isDiscussionResolved({
        notes: [
          { resolvable: false, resolved: false },
          { resolvable: false },
        ],
      }),
      false
    );
  });

  test("all resolvable notes resolved → true", () => {
    assert.equal(
      isDiscussionResolved({
        notes: [
          { resolvable: true, resolved: true },
          { resolvable: true, resolved: true },
        ],
      }),
      true
    );
  });

  test("some resolvable notes unresolved → false", () => {
    assert.equal(
      isDiscussionResolved({
        notes: [
          { resolvable: true, resolved: true },
          { resolvable: true, resolved: false },
        ],
      }),
      false
    );
  });

  test("mix of resolvable and non-resolvable, all resolvable resolved → true", () => {
    assert.equal(
      isDiscussionResolved({
        notes: [
          { resolvable: false, resolved: false },
          { resolvable: true, resolved: true },
        ],
      }),
      true
    );
  });

  test("empty notes array → false", () => {
    assert.equal(isDiscussionResolved({ notes: [] }), false);
  });
});

// ---------------------------------------------------------------------------
// formatMergeRequest
// ---------------------------------------------------------------------------
describe("formatMergeRequest", () => {
  const BASE_MR = {
    iid: 42,
    title: "My MR",
    state: "opened" as const,
    author: { username: "alice" },
    sourceBranch: "feature/foo",
    targetBranch: "main",
    createdAt: "2024-01-15T10:00:00.000Z",
    updatedAt: "2024-01-16T12:00:00.000Z",
    webUrl: "https://gitlab.com/project/-/merge_requests/42",
  };

  test("contains iid and title", () => {
    const result = formatMergeRequest(BASE_MR);
    assert.ok(result.includes("!42: My MR"));
  });

  test("contains state", () => {
    const result = formatMergeRequest(BASE_MR);
    assert.ok(result.includes("opened"));
  });

  test("contains author username with @", () => {
    const result = formatMergeRequest(BASE_MR);
    assert.ok(result.includes("@alice"));
  });

  test("contains source and target branch", () => {
    const result = formatMergeRequest(BASE_MR);
    assert.ok(result.includes("feature/foo"));
    assert.ok(result.includes("main"));
  });

  test("contains web URL", () => {
    const result = formatMergeRequest(BASE_MR);
    assert.ok(result.includes("https://gitlab.com/project/-/merge_requests/42"));
  });

  test("shows (draft) when draft is true", () => {
    const result = formatMergeRequest({ ...BASE_MR, draft: true });
    assert.ok(result.includes("(draft)"));
  });

  test("no (draft) when draft is false", () => {
    const result = formatMergeRequest({ ...BASE_MR, draft: false });
    assert.ok(!result.includes("(draft)"));
  });

  test("shows labels when present", () => {
    const result = formatMergeRequest({
      ...BASE_MR,
      labels: ["bug", "urgent"],
    });
    assert.ok(result.includes("bug"));
    assert.ok(result.includes("urgent"));
  });

  test("does not show Labels line when labels is empty", () => {
    const result = formatMergeRequest({ ...BASE_MR, labels: [] });
    assert.ok(!result.includes("Labels:"));
  });

  test("shows userNotesCount when provided", () => {
    const result = formatMergeRequest({ ...BASE_MR, userNotesCount: 7 });
    assert.ok(result.includes("7"));
  });

  test("does not show Comments line when userNotesCount is undefined", () => {
    const result = formatMergeRequest(BASE_MR);
    assert.ok(!result.includes("Comments:"));
  });
});

// ---------------------------------------------------------------------------
// formatCommit
// ---------------------------------------------------------------------------
describe("formatCommit", () => {
  const BASE_COMMIT = {
    shortId: "abc1234",
    title: "Fix the thing",
    authorName: "Bob",
    authoredDate: "2024-02-10T09:00:00.000Z",
  };

  test("contains short ID and title", () => {
    const result = formatCommit(BASE_COMMIT);
    assert.ok(result.includes("abc1234: Fix the thing"));
  });

  test("contains author name", () => {
    const result = formatCommit(BASE_COMMIT);
    assert.ok(result.includes("Bob"));
  });

  test("contains date section", () => {
    const result = formatCommit(BASE_COMMIT);
    assert.ok(result.includes("Date:"));
  });
});

// ---------------------------------------------------------------------------
// formatDiscussion
// ---------------------------------------------------------------------------
describe("formatDiscussion", () => {
  const discussion = {
    id: "abc",
    individualNote: false,
    notes: [
      {
        id: 1,
        body: "First comment",
        author: { username: "alice" },
        createdAt: "2024-01-01T00:00:00Z",
        system: false,
        resolved: false,
      },
      {
        id: 2,
        body: "Second comment",
        author: { username: "bob" },
        createdAt: "2024-01-02T00:00:00Z",
        system: false,
        resolved: false,
      },
    ],
  };

  test("formats user notes with @username prefix", () => {
    const result = formatDiscussion(discussion);
    assert.ok(result.includes("@alice: First comment"));
    assert.ok(result.includes("@bob: Second comment"));
  });

  test("system notes are excluded by default", () => {
    const withSystem = {
      ...discussion,
      notes: [
        ...discussion.notes,
        {
          id: 3,
          body: "assigned to alice",
          author: { username: "system" },
          createdAt: "2024-01-03T00:00:00Z",
          system: true,
          resolved: false,
        },
      ],
    };
    const result = formatDiscussion(withSystem);
    assert.ok(!result.includes("[sys]"));
    assert.ok(!result.includes("assigned to alice"));
  });

  test("system notes are included when includeSystemNotes=true", () => {
    const withSystem = {
      ...discussion,
      notes: [
        {
          id: 3,
          body: "assigned to alice",
          author: { username: "system" },
          createdAt: "2024-01-03T00:00:00Z",
          system: true,
          resolved: false,
        },
      ],
    };
    const result = formatDiscussion(withSystem, true);
    assert.ok(result.includes("[sys] assigned to alice"));
  });

  test("empty notes array produces empty string", () => {
    const result = formatDiscussion({ id: "x", individualNote: true, notes: [] });
    assert.equal(result, "");
  });

  test("discussion with only system notes and includeSystemNotes=false → empty", () => {
    const sysOnly = {
      id: "x",
      individualNote: false,
      notes: [
        {
          id: 1,
          body: "merged",
          author: { username: "s" },
          createdAt: "2024-01-01T00:00:00Z",
          system: true,
          resolved: false,
        },
      ],
    };
    assert.equal(formatDiscussion(sysOnly), "");
  });
});
