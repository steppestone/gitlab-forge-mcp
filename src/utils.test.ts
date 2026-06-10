/**
 * Unit tests for src/utils.ts
 * Run with: npm test
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  snakeToCamel,
  truncateText,
  extractLines,
  parseGitRemoteUrl,
  parseNetrc,
  getTokenFromNetrc,
  GitLabError,
  ConfigurationError,
  NotFoundError,
  AuthenticationError,
  RateLimitError,
  mcpToolError,
} from "./utils.js";

// ---------------------------------------------------------------------------
// snakeToCamel
// ---------------------------------------------------------------------------
describe("snakeToCamel", () => {
  test("converts simple snake_case keys", () => {
    const result = snakeToCamel<{ fooBar: number }>({ foo_bar: 1 });
    assert.deepEqual(result, { fooBar: 1 });
  });

  test("converts nested objects recursively", () => {
    const result = snakeToCamel<{ outer: { innerKey: string } }>({
      outer: { inner_key: "v" },
    });
    assert.deepEqual(result, { outer: { innerKey: "v" } });
  });

  test("converts arrays of objects", () => {
    const result = snakeToCamel<Array<{ myField: number }>>([
      { my_field: 1 },
      { my_field: 2 },
    ]);
    assert.deepEqual(result, [{ myField: 1 }, { myField: 2 }]);
  });

  test("passes through null", () => {
    assert.equal(snakeToCamel(null), null);
  });

  test("passes through undefined", () => {
    assert.equal(snakeToCamel(undefined), undefined);
  });

  test("passes through primitives", () => {
    assert.equal(snakeToCamel(42), 42);
    assert.equal(snakeToCamel("hello"), "hello");
    assert.equal(snakeToCamel(true), true);
  });

  test("leaves already-camel keys unchanged", () => {
    const result = snakeToCamel<{ webUrl: string }>({ webUrl: "x" });
    assert.deepEqual(result, { webUrl: "x" });
  });

  test("handles multiple underscores in one key", () => {
    const result = snakeToCamel<{ aLongKeyName: number }>({
      a_long_key_name: 7,
    });
    assert.deepEqual(result, { aLongKeyName: 7 });
  });

  test("handles array of primitives unchanged", () => {
    const result = snakeToCamel<number[]>([1, 2, 3]);
    assert.deepEqual(result, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// truncateText
// ---------------------------------------------------------------------------
describe("truncateText", () => {
  test("returns text unchanged when under limit", () => {
    const text = "hello world";
    assert.equal(truncateText(text, 100), text);
  });

  test("returns text unchanged when exactly at limit", () => {
    const text = "a".repeat(100);
    assert.equal(truncateText(text, 100), text);
  });

  test("truncates and inserts marker when over limit", () => {
    const text = "a".repeat(300);
    const result = truncateText(text, 200);
    assert.ok(result.includes("[TRUNCATED"));
    assert.ok(result.length < text.length);
  });

  test("truncated text is shorter than original", () => {
    const text = "x".repeat(500);
    const result = truncateText(text, 200);
    assert.ok(result.length < text.length);
  });

  test("respects newline cut-point when last newline is past 80% of truncatedLength", () => {
    // truncatedLength = maxLength - 100 = 200 - 100 = 100
    // We place a newline at position 95 (> 100 * 0.8 = 80), so it should cut there
    const prefix = "a".repeat(94) + "\n" + "b".repeat(200);
    const result = truncateText(prefix, 200);
    assert.ok(result.includes("[TRUNCATED"));
    // The cut should be at position 94 (the newline)
    assert.ok(result.startsWith("a".repeat(94)));
    // "b" chars are after the cut
    assert.ok(!result.startsWith("a".repeat(94) + "\n" + "b"));
  });

  test("falls back to truncatedLength when newline is before 80% mark", () => {
    // truncatedLength = 100-100 = wait, let's use maxLength=300 => truncatedLength=200
    // place newline at position 10 (< 200*0.8=160), should cut at 200
    const prefix = "a".repeat(10) + "\n" + "c".repeat(400);
    const result = truncateText(prefix, 300);
    assert.ok(result.includes("[TRUNCATED"));
    // cut point is 200, so prefix chars up to 200 are kept
    assert.ok(result.startsWith("a".repeat(10) + "\n"));
  });

  test("marker contains remaining character count", () => {
    // maxLength=200, truncatedLength=100, cutPoint=100 (no newline favored)
    const text = "x".repeat(300);
    const result = truncateText(text, 200);
    // 300 - 100 = 200 remaining
    assert.ok(result.includes("200 more characters"));
  });
});

// ---------------------------------------------------------------------------
// extractLines
// ---------------------------------------------------------------------------
describe("extractLines", () => {
  const LINES = "line1\nline2\nline3\nline4\nline5";

  test("returns all lines with no options", () => {
    const { content, totalLines, returnedRange } = extractLines(LINES);
    assert.equal(content, LINES);
    assert.equal(totalLines, 5);
    assert.equal(returnedRange, "lines 1-5");
  });

  test("returns a specific range", () => {
    const { content, returnedRange } = extractLines(LINES, {
      startLine: 2,
      endLine: 4,
    });
    assert.equal(content, "line2\nline3\nline4");
    assert.equal(returnedRange, "lines 2-4");
  });

  test("clamps end to totalLines", () => {
    const { content, returnedRange } = extractLines(LINES, {
      startLine: 4,
      endLine: 100,
    });
    assert.equal(content, "line4\nline5");
    assert.equal(returnedRange, "lines 4-5");
  });

  test("clamps start to 1 when 0 given", () => {
    const { content } = extractLines(LINES, { startLine: 0 });
    assert.ok(content.startsWith("line1"));
  });

  test("applies maxLines limit", () => {
    const { content, returnedRange } = extractLines(LINES, {
      startLine: 1,
      maxLines: 3,
    });
    assert.equal(content, "line1\nline2\nline3");
    assert.equal(returnedRange, "lines 1-3");
  });

  test("single line produces 'line N' returnedRange", () => {
    const { returnedRange } = extractLines(LINES, {
      startLine: 3,
      endLine: 3,
    });
    assert.equal(returnedRange, "line 3");
  });

  test("out-of-range start clamps to totalLines", () => {
    // start=100 is > totalLines=5, so start=5, end=5
    const { content, returnedRange } = extractLines(LINES, {
      startLine: 100,
      endLine: 200,
    });
    assert.equal(returnedRange, "line 5");
    assert.equal(content, "line5");
  });
});

// ---------------------------------------------------------------------------
// parseGitRemoteUrl
// ---------------------------------------------------------------------------
describe("parseGitRemoteUrl", () => {
  test("parses git@ SSH format", () => {
    const result = parseGitRemoteUrl("git@gitlab.com:mygroup/myproject.git");
    assert.deepEqual(result, {
      host: "gitlab.com",
      projectPath: "mygroup/myproject",
    });
  });

  test("parses git@ SSH format without .git suffix", () => {
    const result = parseGitRemoteUrl("git@gitlab.com:mygroup/myproject");
    assert.deepEqual(result, {
      host: "gitlab.com",
      projectPath: "mygroup/myproject",
    });
  });

  test("parses ssh:// URL format", () => {
    const result = parseGitRemoteUrl(
      "ssh://git@gitlab.com/mygroup/myproject.git"
    );
    assert.deepEqual(result, {
      host: "gitlab.com",
      projectPath: "mygroup/myproject",
    });
  });

  test("parses https:// URL format", () => {
    const result = parseGitRemoteUrl(
      "https://gitlab.com/mygroup/myproject.git"
    );
    assert.deepEqual(result, {
      host: "gitlab.com",
      projectPath: "mygroup/myproject",
    });
  });

  test("parses https:// URL without .git suffix", () => {
    const result = parseGitRemoteUrl("https://gitlab.com/mygroup/myproject");
    assert.deepEqual(result, {
      host: "gitlab.com",
      projectPath: "mygroup/myproject",
    });
  });

  test("parses https:// URL with subgroups", () => {
    const result = parseGitRemoteUrl(
      "https://gitlab.com/top/sub/project.git"
    );
    assert.deepEqual(result, {
      host: "gitlab.com",
      projectPath: "top/sub/project",
    });
  });

  test("parses git@ SSH with subgroups", () => {
    const result = parseGitRemoteUrl(
      "git@gitlab.company.com:a/b/c/project.git"
    );
    assert.deepEqual(result, {
      host: "gitlab.company.com",
      projectPath: "a/b/c/project",
    });
  });

  test("returns null for unparseable URL", () => {
    assert.equal(parseGitRemoteUrl("not-a-url"), null);
    assert.equal(parseGitRemoteUrl(""), null);
    assert.equal(parseGitRemoteUrl("ftp://foo.com/bar"), null);
  });
});

// ---------------------------------------------------------------------------
// parseNetrc / getTokenFromNetrc
// ---------------------------------------------------------------------------
describe("parseNetrc / getTokenFromNetrc", () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitlab-mcp-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty map when .netrc does not exist", () => {
    const entries = parseNetrc();
    assert.equal(entries.size, 0);
  });

  test("parses multi-line .netrc format", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".netrc"),
      "machine gitlab.com\nlogin myuser\npassword mytoken\n"
    );
    const entries = parseNetrc();
    assert.equal(entries.size, 1);
    const entry = entries.get("gitlab.com");
    assert.ok(entry);
    assert.equal(entry.login, "myuser");
    assert.equal(entry.password, "mytoken");
    assert.equal(entry.machine, "gitlab.com");
  });

  test("parses single-line .netrc format", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".netrc"),
      "machine gitlab.com login myuser password mytoken\n"
    );
    const entries = parseNetrc();
    const entry = entries.get("gitlab.com");
    assert.ok(entry);
    assert.equal(entry.password, "mytoken");
  });

  test("parses multiple hosts", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".netrc"),
      [
        "machine gitlab.com",
        "login user1",
        "password token1",
        "machine github.com",
        "login user2",
        "password token2",
      ].join("\n") + "\n"
    );
    const entries = parseNetrc();
    assert.equal(entries.size, 2);
    assert.equal(entries.get("gitlab.com")?.password, "token1");
    assert.equal(entries.get("github.com")?.password, "token2");
  });

  test("skips comment lines", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".netrc"),
      "# this is a comment\nmachine gitlab.com\nlogin u\npassword p\n"
    );
    const entries = parseNetrc();
    assert.equal(entries.size, 1);
  });

  test("getTokenFromNetrc returns password for known host", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".netrc"),
      "machine gitlab.com\nlogin u\npassword secret\n"
    );
    assert.equal(getTokenFromNetrc("gitlab.com"), "secret");
  });

  test("getTokenFromNetrc returns null for unknown host", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".netrc"),
      "machine gitlab.com\nlogin u\npassword secret\n"
    );
    assert.equal(getTokenFromNetrc("notfound.example.com"), null);
  });

  test("getTokenFromNetrc returns null when .netrc absent", () => {
    assert.equal(getTokenFromNetrc("gitlab.com"), null);
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------
describe("Error classes", () => {
  test("GitLabError carries status and code", () => {
    const e = new GitLabError("msg", 500, "SERVER_ERROR");
    assert.equal(e.statusCode, 500);
    assert.equal(e.code, "SERVER_ERROR");
    assert.equal(e.name, "GitLabError");
    assert.ok(e instanceof Error);
  });

  test("ConfigurationError has correct code/name", () => {
    const e = new ConfigurationError("bad config");
    assert.equal(e.code, "CONFIGURATION_ERROR");
    assert.equal(e.name, "ConfigurationError");
    assert.equal(e.statusCode, undefined);
    assert.ok(e instanceof GitLabError);
  });

  test("NotFoundError has 404 status and NOT_FOUND code", () => {
    const e = new NotFoundError("MyResource");
    assert.equal(e.statusCode, 404);
    assert.equal(e.code, "NOT_FOUND");
    assert.equal(e.name, "NotFoundError");
    assert.ok(e.message.includes("MyResource"));
    assert.ok(e instanceof GitLabError);
  });

  test("AuthenticationError has 401 status and AUTHENTICATION_ERROR code", () => {
    const e = new AuthenticationError();
    assert.equal(e.statusCode, 401);
    assert.equal(e.code, "AUTHENTICATION_ERROR");
    assert.equal(e.name, "AuthenticationError");
    assert.ok(e instanceof GitLabError);
  });

  test("RateLimitError has 429 status and RATE_LIMIT code without retryAfter", () => {
    const e = new RateLimitError();
    assert.equal(e.statusCode, 429);
    assert.equal(e.code, "RATE_LIMIT");
    assert.equal(e.name, "RateLimitError");
    assert.ok(!e.message.includes("Retry after"));
  });

  test("RateLimitError includes retryAfter seconds in message", () => {
    const e = new RateLimitError(60);
    assert.ok(e.message.includes("60 seconds"));
    assert.equal(e.statusCode, 429);
  });
});

// ---------------------------------------------------------------------------
// mcpToolError
// ---------------------------------------------------------------------------
describe("mcpToolError", () => {
  test("returns isError:true and correct shape", () => {
    const result = mcpToolError("my-tool", "some-file.ts", new Error("oops"));
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.ok(typeof result.content[0].text === "string");
  });

  test("message contains tool name", () => {
    const result = mcpToolError("my-tool", "some-file.ts", new Error("fail"));
    assert.ok(result.content[0].text.includes("my-tool"));
  });

  test("message contains error message", () => {
    const result = mcpToolError("t", "f.ts", new Error("the actual error"));
    assert.ok(result.content[0].text.includes("the actual error"));
  });

  test("message includes sourceFile path when provided", () => {
    const result = mcpToolError("t", "mr-tools.ts", new Error("e"));
    assert.ok(result.content[0].text.includes("mr-tools.ts"));
  });

  test("falls back to generic path when sourceFile is undefined", () => {
    const result = mcpToolError("t", undefined, new Error("e"));
    assert.ok(result.content[0].text.includes("mcp-servers/gitlab/src/tools/"));
  });

  test("handles non-Error thrown values (string)", () => {
    const result = mcpToolError("t", undefined, "some string error");
    assert.ok(result.content[0].text.includes("some string error"));
  });

  test("handles GitLabError message directly", () => {
    const result = mcpToolError("t", "f.ts", new NotFoundError("Project"));
    assert.ok(result.content[0].text.includes("Project not found"));
  });
});
