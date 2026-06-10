/**
 * Unit tests for src/api/gitlab.ts — GitLabClient via mocked fetch.
 * Run with: npm test
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { GitLabClient } from "./gitlab.js";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  GitLabError,
  resetGitContext,
} from "../utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; opts: RequestInit | undefined };

function makeFetch(
  body: unknown,
  options: {
    status?: number;
    headers?: Record<string, string>;
    isText?: boolean;
  } = {}
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const status = options.status ?? 200;
  const fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ url: String(input), opts: init });
    const responseBody =
      options.isText ? String(body) : JSON.stringify(body);
    const headers = new Headers(options.headers ?? {});
    if (!options.isText) {
      headers.set("content-type", "application/json");
    }
    return new Response(responseBody, { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function makeClient(): GitLabClient {
  return new GitLabClient({
    token: "test-token",
    baseUrl: "https://gitlab.example.com",
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Reset git context cache so no auto-detected project leaks in
  resetGitContext();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Constructor — token / baseUrl
// ---------------------------------------------------------------------------
describe("GitLabClient constructor", () => {
  test("accepts explicit token + baseUrl without git/netrc detection", () => {
    const client = makeClient();
    assert.equal(client.getBaseUrl(), "https://gitlab.example.com");
  });

  test("strips trailing slash from baseUrl", () => {
    const client = new GitLabClient({
      token: "tok",
      baseUrl: "https://gitlab.example.com/",
    });
    assert.equal(client.getBaseUrl(), "https://gitlab.example.com");
  });
});

// ---------------------------------------------------------------------------
// projectPath encoding
// ---------------------------------------------------------------------------
describe("projectPath URL encoding", () => {
  test("encodes slashes and spaces in project id", async () => {
    const { fetch, calls } = makeFetch({ id: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getProject("group/sub project");
    assert.ok(calls[0].url.includes("group%2Fsub%20project"), calls[0].url);
  });

  test("encodes numeric project id as string", async () => {
    const { fetch, calls } = makeFetch({ id: 99 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getProject(99);
    assert.ok(calls[0].url.includes("/projects/99"), calls[0].url);
  });

  test("encodes subgroup paths with multiple slashes", async () => {
    const { fetch, calls } = makeFetch({ id: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getProject("top/mid/leaf");
    assert.ok(
      calls[0].url.includes("top%2Fmid%2Fleaf"),
      calls[0].url
    );
  });
});

// ---------------------------------------------------------------------------
// buildQuery — via listMergeRequests / listIssues / listPipelineJobs
// ---------------------------------------------------------------------------
describe("buildQuery", () => {
  test("omits undefined options from query string", async () => {
    const { fetch, calls } = makeFetch(
      { data: [], page: 1, per_page: 20, total_pages: 1, total: 0 },
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listMergeRequests("proj/x");
    // No state/scope/etc params should appear
    const url = calls[0].url;
    assert.ok(!url.includes("state="), url);
    assert.ok(!url.includes("scope="), url);
  });

  test("includes state and scope when provided", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listMergeRequests("proj/x", {
      state: "opened",
      scope: "created_by_me",
    });
    const url = calls[0].url;
    assert.ok(url.includes("state=opened"), url);
    assert.ok(url.includes("scope=created_by_me"), url);
  });

  test("joins labels array with comma", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listMergeRequests("proj/x", {
      labels: ["bug", "urgent", "v2"],
    });
    const url = calls[0].url;
    assert.ok(url.includes("labels=bug%2Curgent%2Cv2") || url.includes("labels=bug,urgent,v2"), url);
  });

  test("listPipelineJobs uses scope[] key", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listPipelineJobs("proj/x", 123, { scope: "failed" });
    const url = calls[0].url;
    // scope[] should be in the URL (URL-encoded as scope%5B%5D or scope[])
    assert.ok(
      url.includes("scope%5B%5D=failed") || url.includes("scope[]=failed"),
      url
    );
  });

  test("listPipelineJobs omits scope when not provided", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listPipelineJobs("proj/x", 123);
    const url = calls[0].url;
    assert.ok(!url.includes("scope"), url);
  });

  test("listPipelines uses String() for yamlErrors boolean", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listPipelines("proj/x", { yamlErrors: true });
    const url = calls[0].url;
    assert.ok(url.includes("yaml_errors=true"), url);
  });

  test("listIssues includes assignee_id and author_id when non-zero", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listIssues("proj/x", { assigneeId: 5, authorId: 10 });
    const url = calls[0].url;
    assert.ok(url.includes("assignee_id=5"), url);
    assert.ok(url.includes("author_id=10"), url);
  });
});

// ---------------------------------------------------------------------------
// compactBody — via createMergeRequest / updateIssue / createPipeline / createProjectAccessToken
// ---------------------------------------------------------------------------
describe("compactBody", () => {
  test("createMergeRequest sends required fields only when optionals absent", async () => {
    const { fetch, calls } = makeFetch({ id: 1, iid: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.createMergeRequest("proj/x", {
      sourceBranch: "feat",
      targetBranch: "main",
      title: "My MR",
    });
    const body = JSON.parse(calls[0].opts?.body as string);
    assert.equal(body.source_branch, "feat");
    assert.equal(body.target_branch, "main");
    assert.equal(body.title, "My MR");
    // undefined-valued keys should be absent
    assert.ok(!("description" in body), JSON.stringify(body));
    assert.ok(!("assignee_id" in body), JSON.stringify(body));
    assert.ok(!("reviewer_ids" in body), JSON.stringify(body));
    assert.ok(!("labels" in body), JSON.stringify(body));
    assert.ok(!("draft" in body), JSON.stringify(body));
  });

  test("createMergeRequest includes labels joined by comma", async () => {
    const { fetch, calls } = makeFetch({ id: 1, iid: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.createMergeRequest("proj/x", {
      sourceBranch: "feat",
      targetBranch: "main",
      title: "T",
      labels: ["a", "b"],
    });
    const body = JSON.parse(calls[0].opts?.body as string);
    assert.equal(body.labels, "a,b");
  });

  test("createMergeRequest includes reviewerIds as array", async () => {
    const { fetch, calls } = makeFetch({ id: 1, iid: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.createMergeRequest("proj/x", {
      sourceBranch: "feat",
      targetBranch: "main",
      title: "T",
      reviewerIds: [1, 2],
    });
    const body = JSON.parse(calls[0].opts?.body as string);
    assert.deepEqual(body.reviewer_ids, [1, 2]);
  });

  test("updateIssue only sends provided fields, drops undefined", async () => {
    const { fetch, calls } = makeFetch({ id: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.updateIssue("proj/x", 1, { title: "New title" });
    const body = JSON.parse(calls[0].opts?.body as string);
    assert.equal(body.title, "New title");
    assert.ok(!("description" in body), JSON.stringify(body));
    assert.ok(!("state_event" in body), JSON.stringify(body));
  });

  test("createPipeline sends ref and variables", async () => {
    const { fetch, calls } = makeFetch({ id: 10 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.createPipeline("proj/x", "main", [
      { key: "VAR1", value: "val1" },
    ]);
    const body = JSON.parse(calls[0].opts?.body as string);
    assert.equal(body.ref, "main");
    assert.deepEqual(body.variables, [
      { key: "VAR1", value: "val1", variable_type: "env_var" },
    ]);
  });

  test("createPipeline omits variables when array is empty", async () => {
    const { fetch, calls } = makeFetch({ id: 10 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.createPipeline("proj/x", "main", []);
    const body = JSON.parse(calls[0].opts?.body as string);
    assert.ok(!("variables" in body), JSON.stringify(body));
  });

  test("createProjectAccessToken sends snake_case keys", async () => {
    const { fetch, calls } = makeFetch({ id: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.createProjectAccessToken("proj/x", {
      name: "ci-token",
      scopes: ["read_api"],
      accessLevel: 40,
      expiresAt: "2025-12-31",
    });
    const body = JSON.parse(calls[0].opts?.body as string);
    assert.equal(body.name, "ci-token");
    assert.deepEqual(body.scopes, ["read_api"]);
    assert.equal(body.access_level, 40);
    assert.equal(body.expires_at, "2025-12-31");
  });
});

// ---------------------------------------------------------------------------
// handleErrorResponse — error funnel
// ---------------------------------------------------------------------------
describe("handleErrorResponse", () => {
  test("401 → AuthenticationError via request (getProject)", async () => {
    const { fetch } = makeFetch("Unauthorized", { status: 401 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.getProject("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof AuthenticationError, `Expected AuthenticationError, got ${e}`);
        return true;
      }
    );
  });

  test("404 → NotFoundError via request (getProject)", async () => {
    const { fetch } = makeFetch("Not Found", { status: 404 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.getProject("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof NotFoundError, `Expected NotFoundError, got ${e}`);
        return true;
      }
    );
  });

  test("429 → RateLimitError with retryAfter via request", async () => {
    const { fetch } = makeFetch("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": "30" },
    });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.getProject("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof RateLimitError, `Expected RateLimitError, got ${e}`);
        assert.ok((e as RateLimitError).message.includes("30 seconds"));
        return true;
      }
    );
  });

  test("429 → RateLimitError without retryAfter", async () => {
    const { fetch } = makeFetch("Too Many Requests", { status: 429 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.getProject("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof RateLimitError);
        return true;
      }
    );
  });

  test("500 → GitLabError (not a typed subclass) via request", async () => {
    const { fetch } = makeFetch("Internal Server Error", { status: 500 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.getProject("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof GitLabError);
        assert.ok(!(e instanceof AuthenticationError));
        assert.ok(!(e instanceof NotFoundError));
        assert.ok(!(e instanceof RateLimitError));
        assert.equal((e as GitLabError).statusCode, 500);
        return true;
      }
    );
  });

  test("404 → NotFoundError via paginatedRequest (listMergeRequests)", async () => {
    const { fetch } = makeFetch("Not Found", { status: 404 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.listMergeRequests("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof NotFoundError, `Expected NotFoundError, got ${e}`);
        return true;
      }
    );
  });

  test("401 → AuthenticationError via paginatedRequest (listIssues)", async () => {
    const { fetch } = makeFetch("Unauthorized", { status: 401 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.listIssues("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof AuthenticationError, `Got ${e}`);
        return true;
      }
    );
  });

  test("429 with Retry-After via paginatedRequest", async () => {
    const { fetch } = makeFetch("rate limited", {
      status: 429,
      headers: { "Retry-After": "15" },
    });
    globalThis.fetch = fetch;
    const client = makeClient();
    await assert.rejects(
      () => client.listPipelines("proj/x"),
      (e: unknown) => {
        assert.ok(e instanceof RateLimitError);
        assert.ok((e as RateLimitError).message.includes("15 seconds"));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// requestText — raw text, no snakeToCamel
// ---------------------------------------------------------------------------
describe("requestText", () => {
  test("getFileRaw returns verbatim text body", async () => {
    const rawContent = "raw_file_content: some_value\nno_camel_here";
    const { fetch } = makeFetch(rawContent, { isText: true });
    globalThis.fetch = fetch;
    const client = makeClient();
    const result = await client.getFileRaw("proj/x", "README.md");
    assert.equal(result, rawContent);
    // Confirm no camelCasing happened
    assert.ok(result.includes("raw_file_content"), result);
    assert.ok(result.includes("no_camel_here"), result);
  });

  test("getFileRaw builds correct URL with encoded path and ref", async () => {
    const { fetch, calls } = makeFetch("content", { isText: true });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getFileRaw("group%2Fproject", "src/foo.ts", "main");
    const url = calls[0].url;
    assert.ok(url.includes("/repository/files/"), url);
    assert.ok(url.includes("/raw"), url);
    assert.ok(url.includes("ref=main"), url);
  });

  test("getJobLog returns verbatim log text", async () => {
    const log = "Running job...\nstep_one: ok\nstep_two: failed";
    const { fetch } = makeFetch(log, { isText: true });
    globalThis.fetch = fetch;
    const client = makeClient();
    const result = await client.getJobLog("proj/x", 456);
    assert.equal(result, log);
    assert.ok(result.includes("step_one"), result);
  });

  test("getJobLog builds correct URL with job id", async () => {
    const { fetch, calls } = makeFetch("log data", { isText: true });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getJobLog("proj/x", 789);
    const url = calls[0].url;
    assert.ok(url.includes("/jobs/789/trace"), url);
  });

  test("requestText does NOT set Content-Type: application/json header", async () => {
    const { fetch, calls } = makeFetch("text", { isText: true });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getJobLog("proj/x", 1);
    const headers = calls[0].opts?.headers as Record<string, string> | undefined;
    // requestText merges headers but does NOT add Content-Type
    if (headers) {
      assert.ok(
        !("content-type" in headers) && !("Content-Type" in headers),
        `Should not have Content-Type in requestText, got: ${JSON.stringify(headers)}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// snakeToCamel on JSON response path (request method)
// ---------------------------------------------------------------------------
describe("snakeToCamel via request", () => {
  test("getProject camelCases response keys", async () => {
    const { fetch } = makeFetch({
      id: 1,
      web_url: "https://gitlab.example.com/proj",
      path_with_namespace: "group/proj",
    });
    globalThis.fetch = fetch;
    const client = makeClient();
    const project = await client.getProject("proj/x");
    const p = project as unknown as Record<string, unknown>;
    assert.equal(p.webUrl, "https://gitlab.example.com/proj");
    assert.equal(p.pathWithNamespace, "group/proj");
    assert.ok(!("web_url" in p), "Original snake_case key should be absent");
  });
});

// ---------------------------------------------------------------------------
// paginatedRequest — envelope and pagination headers
// ---------------------------------------------------------------------------
describe("paginatedRequest", () => {
  test("returns PaginatedResponse envelope with camelCased data", async () => {
    const { fetch } = makeFetch(
      [{ id: 1, web_url: "https://x.com", source_branch: "feat" }],
      {
        headers: {
          "X-Total-Pages": "5",
          "X-Total": "100",
          "X-Next-Page": "2",
          "X-Prev-Page": "",
        },
      }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    const resp = await client.listMergeRequests("proj/x", {
      page: 1,
      perPage: 20,
    });
    assert.equal(resp.totalPages, 5);
    assert.equal(resp.total, 100);
    assert.equal(resp.nextPage, 2);
    assert.equal(resp.prevPage, null);
    assert.equal(resp.page, 1);
    assert.equal(resp.perPage, 20);
    assert.ok(Array.isArray(resp.data));
    // camelCase applied to data items
    const item = resp.data[0] as unknown as Record<string, unknown>;
    assert.equal(item.webUrl, "https://x.com");
    assert.equal(item.sourceBranch, "feat");
  });

  test("prevPage is populated correctly", async () => {
    const { fetch } = makeFetch(
      [],
      {
        headers: {
          "X-Total-Pages": "3",
          "X-Total": "60",
          "X-Next-Page": "3",
          "X-Prev-Page": "1",
        },
      }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    const resp = await client.listMergeRequests("proj/x");
    assert.equal(resp.prevPage, 1);
    assert.equal(resp.nextPage, 3);
  });

  test("totalPages defaults to 1 when header absent", async () => {
    const { fetch } = makeFetch([], {
      headers: { "X-Total": "0" },
    });
    globalThis.fetch = fetch;
    const client = makeClient();
    const resp = await client.listMergeRequests("proj/x");
    assert.equal(resp.totalPages, 1);
  });

  test("total defaults to 0 when header absent", async () => {
    const { fetch } = makeFetch([], {
      headers: { "X-Total-Pages": "1" },
    });
    globalThis.fetch = fetch;
    const client = makeClient();
    const resp = await client.listMergeRequests("proj/x");
    assert.equal(resp.total, 0);
  });

  test("paginatedRequest appends page and per_page params", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listMergeRequests("proj/x", { page: 3, perPage: 50 });
    const url = calls[0].url;
    assert.ok(url.includes("page=3"), url);
    assert.ok(url.includes("per_page=50"), url);
  });

  test("PRIVATE-TOKEN header is sent in paginatedRequest", async () => {
    const { fetch, calls } = makeFetch(
      [],
      { headers: { "X-Total-Pages": "1", "X-Total": "0" } }
    );
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.listMergeRequests("proj/x");
    const headers = calls[0].opts?.headers as Record<string, string>;
    assert.equal(headers["PRIVATE-TOKEN"], "test-token");
  });
});

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------
describe("URL construction", () => {
  test("uses baseUrl + /api/v4 prefix for all requests", async () => {
    const { fetch, calls } = makeFetch({ id: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getProject("group/project");
    assert.ok(
      calls[0].url.startsWith("https://gitlab.example.com/api/v4"),
      calls[0].url
    );
  });

  test("PRIVATE-TOKEN header is sent in request", async () => {
    const { fetch, calls } = makeFetch({ id: 1 });
    globalThis.fetch = fetch;
    const client = makeClient();
    await client.getProject("group/project");
    const headers = calls[0].opts?.headers as Record<string, string>;
    assert.equal(headers["PRIVATE-TOKEN"], "test-token");
  });
});
