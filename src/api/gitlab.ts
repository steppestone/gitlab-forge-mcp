/**
 * GitLab API client.
 */

import type {
  GitLabConfig,
  GitLabProject,
  GitLabBranch,
  GitLabCommit,
  GitLabCommitDiff,
  GitLabMergeRequest,
  GitLabMRChanges,
  GitLabDiscussion,
  GitLabNote,
  GitLabPipeline,
  GitLabPipelineDetailed,
  GitLabJob,
  GitLabFile,
  GitLabTreeItem,
  GitLabIssue,
  GitLabLabel,
  GitLabDraftNote,
  GitLabDraftNotePosition,
  GitLabAccessToken,
  GitLabUser,
  PaginatedResponse,
} from "../types.js";
import {
  debug,
  snakeToCamel,
  GitLabError,
  ConfigurationError,
  NotFoundError,
  AuthenticationError,
  RateLimitError,
  getGitContext,
  getTokenFromNetrc,
  getTokenFromFile,
  type GitContext,
} from "../utils.js";
import { getEffectiveCwd } from "../session-context.js";

/**
 * Append a draft-note position to a form body using GitLab's required
 * bracket-notation keys (`position[base_sha]`, `position[new_line]`, …).
 * Rails/Grape parses these as a nested hash; nested JSON is silently ignored
 * by the draft_notes endpoint, which is why drafts publish as general comments
 * when position is sent as JSON.
 */
function appendPositionFormFields(
  form: URLSearchParams,
  p: GitLabDraftNotePosition
): void {
  form.append("position[position_type]", p.positionType);
  form.append("position[base_sha]", p.baseSha);
  form.append("position[head_sha]", p.headSha);
  form.append("position[start_sha]", p.startSha);
  if (p.oldPath != null) form.append("position[old_path]", p.oldPath);
  if (p.newPath != null) form.append("position[new_path]", p.newPath);
  if (p.oldLine != null) form.append("position[old_line]", String(p.oldLine));
  if (p.newLine != null) form.append("position[new_line]", String(p.newLine));
  if (p.lineRange !== undefined) {
    form.append("position[line_range]", JSON.stringify(p.lineRange));
  }
}

/**
 * Resolve the base URL from explicit config, environment, git context, or the
 * gitlab.com default. The trailing slash is stripped.
 */
function resolveBaseUrl(
  config: Partial<GitLabConfig> | undefined,
  gitContext: GitContext | null
): string {
  let baseUrl: string;
  if (config?.baseUrl) {
    baseUrl = config.baseUrl;
  } else if (process.env.GITLAB_URL) {
    baseUrl = process.env.GITLAB_URL;
  } else if (gitContext) {
    baseUrl = gitContext.baseUrl;
    debug(`Using GitLab URL from git remote: ${baseUrl}`);
  } else {
    baseUrl = "https://gitlab.com";
  }

  // Remove trailing slash from baseUrl
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Look up a token from ~/.netrc for the given host, logging on success.
 * Returns "" if no entry is found.
 */
function resolveNetrcToken(host: string): string {
  const netrcToken = getTokenFromNetrc(host);
  if (netrcToken) {
    debug(`Using token from .netrc for ${host}`);
    return netrcToken;
  }
  return "";
}

/**
 * Resolve the API token from explicit config, the project `.gitlab-token`
 * file, the GITLAB_TOKEN environment variable, or ~/.netrc — in that order.
 * Returns "" when no token can be found.
 */
function resolveToken(
  config: Partial<GitLabConfig> | undefined,
  gitContext: GitContext | null,
  host: string
): string {
  if (config?.token) {
    return config.token;
  }

  if (gitContext) {
    // Try .gitlab-token file in git root first
    const fileToken = getTokenFromFile(gitContext.gitRoot);
    if (fileToken) {
      return fileToken;
    }
  }

  if (process.env.GITLAB_TOKEN) {
    return process.env.GITLAB_TOKEN;
  }

  return resolveNetrcToken(host);
}

/**
 * GitLab API client class.
 *
 * Authentication resolution order:
 * 1. Explicit config.token
 * 2. .gitlab-token file in git root (project-specific)
 * 3. GITLAB_TOKEN environment variable
 * 4. Token from ~/.netrc for the detected/configured host
 *
 * Base URL resolution order:
 * 1. Explicit config.baseUrl
 * 2. GITLAB_URL environment variable
 * 3. Auto-detected from git remote origin
 * 4. Default: https://gitlab.com
 */
export class GitLabClient {
  private baseUrl: string;
  private token: string;
  private gitContext: GitContext | null;

  constructor(config?: Partial<GitLabConfig>) {
    // Detect git context first
    this.gitContext = getGitContext();

    this.baseUrl = resolveBaseUrl(config, this.gitContext);

    // Extract host for netrc lookup — use hostname (not host) to exclude port numbers
    const host = new URL(this.baseUrl).hostname;

    this.token = resolveToken(config, this.gitContext, host);

    if (!this.token) {
      throw new ConfigurationError(
        `GitLab token not found. Options:\n` +
          `  1. Create .gitlab-token file in git root\n` +
          `  2. Set GITLAB_TOKEN environment variable\n` +
          `  3. Add entry to ~/.netrc:\n` +
          `     machine ${host}\n` +
          `     login your-username\n` +
          `     password your-token`
      );
    }
  }

  /**
   * Get the detected git context (if available).
   */
  getGitContext(): GitContext | null {
    return this.gitContext;
  }

  /**
   * Get the default project path from git context.
   */
  getDefaultProject(): string | null {
    return this.gitContext?.projectPath || null;
  }

  /**
   * Get the current branch from git context.
   */
  getCurrentBranch(): string | null {
    return this.gitContext?.currentBranch || null;
  }

  /**
   * Get the configured base URL.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Read an error response body, log it, and throw the appropriate typed
   * error. Shared by all request helpers so every GitLab call maps status
   * codes consistently (401→Auth, 404→NotFound, 429→RateLimit, else GitLab).
   */
  private async handleErrorResponse(
    response: Response,
    notFoundLabel = "Resource"
  ): Promise<never> {
    const errorBody = await response.text();
    debug(`GitLab API error: ${response.status} ${errorBody}`);

    switch (response.status) {
      case 401:
        throw new AuthenticationError();
      case 404:
        throw new NotFoundError(notFoundLabel);
      case 429: {
        const retryAfter = response.headers.get("Retry-After");
        throw new RateLimitError(retryAfter ? parseInt(retryAfter) : undefined);
      }
      default:
        throw new GitLabError(
          `GitLab API error: ${response.status} ${errorBody}`,
          response.status
        );
    }
  }

  /**
   * Build the project base path (`/projects/:encodedId`) for API endpoints.
   */
  private projectPath(projectId: string | number): string {
    return `/projects/${encodeURIComponent(String(projectId))}`;
  }

  /**
   * Build a query string from a params object. Keys are passed pre-snake-cased
   * by callers. `undefined` values are skipped; arrays are joined with ",";
   * everything else is coerced via String(). Returns "" or "?...".
   */
  private buildQuery(
    params: Record<string, string | number | boolean | string[] | undefined>
  ): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      search.append(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const query = search.toString();
    return query ? `?${query}` : "";
  }

  /**
   * Strip keys whose value is `undefined` from a request body object.
   */
  private compactBody(
    body: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  /**
   * Make an authenticated request to the GitLab API.
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    notFoundLabel = "Resource"
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v4${endpoint}`;
    debug(`GitLab API request: ${options.method || "GET"} ${url}`);

    const response = await fetch(url, {
      ...options,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) await this.handleErrorResponse(response, notFoundLabel);

    const data = await response.json();
    return snakeToCamel<T>(data);
  }

  /**
   * Make an authenticated request that returns the raw response body as text
   * (no snakeToCamel). Used for endpoints like raw file content and job logs.
   */
  private async requestText(
    endpoint: string,
    options: RequestInit = {},
    notFoundLabel = "Resource"
  ): Promise<string> {
    const url = `${this.baseUrl}/api/v4${endpoint}`;
    debug(`GitLab API request: ${options.method || "GET"} ${url}`);

    const response = await fetch(url, {
      ...options,
      headers: {
        "PRIVATE-TOKEN": this.token,
        ...options.headers,
      },
    });

    if (!response.ok) await this.handleErrorResponse(response, notFoundLabel);

    return response.text();
  }

  /**
   * Make an authenticated form-encoded request. Used for endpoints that require
   * bracket-notation params (e.g. `position[base_sha]`) which Rails/Grape parse
   * from form bodies but not from nested JSON — notably the draft_notes API.
   */
  private async formRequest<T>(
    endpoint: string,
    method: "POST" | "PUT",
    form: URLSearchParams
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v4${endpoint}`;
    debug(`GitLab API form request: ${method} ${url}`);

    const response = await fetch(url, {
      method,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!response.ok) await this.handleErrorResponse(response);

    const data = await response.json();
    return snakeToCamel<T>(data);
  }

  /**
   * Make an authenticated request that returns no body (e.g. DELETE → 204).
   */
  private async voidRequest(
    endpoint: string,
    options: RequestInit = {},
    notFoundLabel = "Resource"
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v4${endpoint}`;
    debug(`GitLab API request: ${options.method || "GET"} ${url}`);

    const response = await fetch(url, {
      ...options,
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) await this.handleErrorResponse(response, notFoundLabel);
  }

  /**
   * Make a paginated request.
   */
  private async paginatedRequest<T>(
    endpoint: string,
    page: number = 1,
    perPage: number = 20
  ): Promise<PaginatedResponse<T>> {
    const separator = endpoint.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}/api/v4${endpoint}${separator}page=${page}&per_page=${perPage}`;

    const response = await fetch(url, {
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) await this.handleErrorResponse(response);

    const data = await response.json();
    const totalPages = parseInt(response.headers.get("X-Total-Pages") || "1");
    const total = parseInt(response.headers.get("X-Total") || "0");
    const nextPage = response.headers.get("X-Next-Page");
    const prevPage = response.headers.get("X-Prev-Page");

    return {
      data: snakeToCamel<T[]>(data),
      page,
      perPage,
      totalPages,
      total,
      nextPage: nextPage ? parseInt(nextPage) : null,
      prevPage: prevPage ? parseInt(prevPage) : null,
    };
  }

  // ============================================================================
  // PROJECT METHODS
  // ============================================================================

  /**
   * Get a project by ID or path.
   */
  async getProject(projectId: string | number): Promise<GitLabProject> {
    return this.request<GitLabProject>(this.projectPath(projectId));
  }

  /**
   * List projects accessible to the user.
   */
  async listProjects(
    options: {
      search?: string;
      owned?: boolean;
      membership?: boolean;
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabProject>> {
    const query = this.buildQuery({
      search: options.search,
      owned: options.owned ? "true" : undefined,
      membership: options.membership ? "true" : undefined,
    });
    return this.paginatedRequest<GitLabProject>(
      `/projects${query}`,
      options.page,
      options.perPage
    );
  }

  // ============================================================================
  // REPOSITORY METHODS
  // ============================================================================

  /**
   * List branches in a project.
   */
  async listBranches(
    projectId: string | number,
    options: { search?: string; page?: number; perPage?: number } = {}
  ): Promise<PaginatedResponse<GitLabBranch>> {
    const query = this.buildQuery({ search: options.search });
    return this.paginatedRequest<GitLabBranch>(
      `${this.projectPath(projectId)}/repository/branches${query}`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific branch.
   */
  async getBranch(
    projectId: string | number,
    branchName: string
  ): Promise<GitLabBranch> {
    const encodedBranch = encodeURIComponent(branchName);
    return this.request<GitLabBranch>(
      `${this.projectPath(projectId)}/repository/branches/${encodedBranch}`
    );
  }

  /**
   * List commits in a project.
   */
  async listCommits(
    projectId: string | number,
    options: {
      refName?: string;
      path?: string;
      since?: string;
      until?: string;
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabCommit>> {
    const query = this.buildQuery({
      ref_name: options.refName,
      path: options.path,
      since: options.since,
      until: options.until,
    });
    return this.paginatedRequest<GitLabCommit>(
      `${this.projectPath(projectId)}/repository/commits${query}`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific commit.
   */
  async getCommit(
    projectId: string | number,
    sha: string
  ): Promise<GitLabCommit> {
    return this.request<GitLabCommit>(
      `${this.projectPath(projectId)}/repository/commits/${sha}`
    );
  }

  /**
   * Get the diff for a commit.
   */
  async getCommitDiff(
    projectId: string | number,
    sha: string
  ): Promise<GitLabCommitDiff[]> {
    return this.request<GitLabCommitDiff[]>(
      `${this.projectPath(projectId)}/repository/commits/${sha}/diff`
    );
  }

  /**
   * Get file content from repository.
   */
  async getFile(
    projectId: string | number,
    filePath: string,
    ref: string = "HEAD"
  ): Promise<GitLabFile> {
    const encodedPath = encodeURIComponent(filePath);
    return this.request<GitLabFile>(
      `${this.projectPath(projectId)}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`
    );
  }

  /**
   * Get raw file content from repository.
   */
  async getFileRaw(
    projectId: string | number,
    filePath: string,
    ref: string = "HEAD"
  ): Promise<string> {
    const encodedPath = encodeURIComponent(filePath);
    return this.requestText(
      `${this.projectPath(projectId)}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
      {},
      `File ${filePath}`
    );
  }

  /**
   * List repository tree (files and directories).
   */
  async listTree(
    projectId: string | number,
    options: {
      path?: string;
      ref?: string;
      recursive?: boolean;
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabTreeItem>> {
    const query = this.buildQuery({
      path: options.path,
      ref: options.ref,
      recursive: options.recursive ? "true" : undefined,
    });
    return this.paginatedRequest<GitLabTreeItem>(
      `${this.projectPath(projectId)}/repository/tree${query}`,
      options.page,
      options.perPage
    );
  }

  // ============================================================================
  // MERGE REQUEST METHODS
  // ============================================================================

  /**
   * List merge requests in a project.
   */
  async listMergeRequests(
    projectId: string | number,
    options: {
      state?: "opened" | "closed" | "merged" | "locked" | "all";
      scope?: "created_by_me" | "assigned_to_me" | "all";
      authorId?: number;
      assigneeId?: number;
      reviewerId?: number;
      labels?: string[];
      milestone?: string;
      search?: string;
      sourceBranch?: string;
      targetBranch?: string;
      orderBy?: "created_at" | "updated_at";
      sort?: "asc" | "desc";
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabMergeRequest>> {
    const query = this.buildQuery({
      state: options.state,
      scope: options.scope,
      author_id: options.authorId || undefined,
      assignee_id: options.assigneeId || undefined,
      reviewer_id: options.reviewerId || undefined,
      labels: options.labels ? options.labels.join(",") : undefined,
      milestone: options.milestone,
      search: options.search,
      source_branch: options.sourceBranch,
      target_branch: options.targetBranch,
      order_by: options.orderBy,
      sort: options.sort,
    });
    return this.paginatedRequest<GitLabMergeRequest>(
      `${this.projectPath(projectId)}/merge_requests${query}`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific merge request.
   */
  async getMergeRequest(
    projectId: string | number,
    mrIid: number
  ): Promise<GitLabMergeRequest> {
    return this.request<GitLabMergeRequest>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}`
    );
  }

  /**
   * Get merge request changes (diff).
   */
  async getMergeRequestChanges(
    projectId: string | number,
    mrIid: number
  ): Promise<GitLabMRChanges> {
    return this.request<GitLabMRChanges>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/changes`
    );
  }

  /**
   * Get merge request commits.
   */
  async getMergeRequestCommits(
    projectId: string | number,
    mrIid: number,
    options: { page?: number; perPage?: number } = {}
  ): Promise<PaginatedResponse<GitLabCommit>> {
    return this.paginatedRequest<GitLabCommit>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/commits`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get merge request pipelines.
   */
  async getMergeRequestPipelines(
    projectId: string | number,
    mrIid: number,
    options: { page?: number; perPage?: number } = {}
  ): Promise<PaginatedResponse<GitLabPipeline>> {
    return this.paginatedRequest<GitLabPipeline>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/pipelines`,
      options.page,
      options.perPage
    );
  }

  /**
   * Create a merge request.
   */
  async createMergeRequest(
    projectId: string | number,
    options: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description?: string;
      assigneeId?: number;
      reviewerIds?: number[];
      labels?: string[];
      milestone?: string;
      draft?: boolean;
      removeSourceBranch?: boolean;
      squash?: boolean;
    }
  ): Promise<GitLabMergeRequest> {
    const body = this.compactBody({
      source_branch: options.sourceBranch,
      target_branch: options.targetBranch,
      title: options.title,
      description: options.description || undefined,
      assignee_id: options.assigneeId || undefined,
      reviewer_ids:
        options.reviewerIds && options.reviewerIds.length > 0
          ? options.reviewerIds
          : undefined,
      labels:
        options.labels && options.labels.length > 0
          ? options.labels.join(",")
          : undefined,
      milestone: options.milestone || undefined,
      draft: options.draft || undefined,
      remove_source_branch:
        options.removeSourceBranch !== undefined
          ? options.removeSourceBranch
          : undefined,
      squash: options.squash !== undefined ? options.squash : undefined,
    });

    return this.request<GitLabMergeRequest>(
      `${this.projectPath(projectId)}/merge_requests`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
  }

  // ============================================================================
  // PIPELINE METHODS
  // ============================================================================

  /**
   * List pipelines in a project.
   */
  async listPipelines(
    projectId: string | number,
    options: {
      scope?: "running" | "pending" | "finished" | "branches" | "tags";
      status?: "created" | "waiting_for_resource" | "preparing" | "pending" | "running" | "success" | "failed" | "canceled" | "skipped" | "manual" | "scheduled";
      ref?: string;
      sha?: string;
      yamlErrors?: boolean;
      username?: string;
      orderBy?: "id" | "status" | "ref" | "updated_at" | "user_id";
      sort?: "asc" | "desc";
      source?: string;
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabPipeline>> {
    const query = this.buildQuery({
      scope: options.scope,
      status: options.status,
      ref: options.ref,
      sha: options.sha,
      yaml_errors:
        options.yamlErrors !== undefined ? String(options.yamlErrors) : undefined,
      username: options.username,
      order_by: options.orderBy,
      sort: options.sort,
      source: options.source,
    });
    return this.paginatedRequest<GitLabPipeline>(
      `${this.projectPath(projectId)}/pipelines${query}`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific pipeline.
   */
  async getPipeline(
    projectId: string | number,
    pipelineId: number
  ): Promise<GitLabPipelineDetailed> {
    return this.request<GitLabPipelineDetailed>(
      `${this.projectPath(projectId)}/pipelines/${pipelineId}`
    );
  }

  /**
   * List jobs in a pipeline.
   */
  async listPipelineJobs(
    projectId: string | number,
    pipelineId: number,
    options: {
      scope?: "created" | "pending" | "running" | "failed" | "success" | "canceled" | "skipped" | "manual";
      includeRetried?: boolean;
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabJob>> {
    const query = this.buildQuery({
      "scope[]": options.scope,
      include_retried:
        options.includeRetried !== undefined
          ? String(options.includeRetried)
          : undefined,
    });
    return this.paginatedRequest<GitLabJob>(
      `${this.projectPath(projectId)}/pipelines/${pipelineId}/jobs${query}`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific job.
   */
  async getJob(
    projectId: string | number,
    jobId: number
  ): Promise<GitLabJob> {
    return this.request<GitLabJob>(`${this.projectPath(projectId)}/jobs/${jobId}`);
  }

  /**
   * Get job log (trace).
   */
  async getJobLog(
    projectId: string | number,
    jobId: number
  ): Promise<string> {
    return this.requestText(
      `${this.projectPath(projectId)}/jobs/${jobId}/trace`,
      {},
      `Job ${jobId}`
    );
  }

  // ============================================================================
  // ISSUE METHODS
  // ============================================================================

  /**
   * List issues in a project.
   */
  async listIssues(
    projectId: string | number,
    options: {
      state?: "opened" | "closed" | "all";
      labels?: string;
      milestone?: string;
      assigneeId?: number;
      authorId?: number;
      search?: string;
      scope?: "created_by_me" | "assigned_to_me" | "all";
      orderBy?: "created_at" | "updated_at";
      sort?: "asc" | "desc";
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabIssue>> {
    const query = this.buildQuery({
      state: options.state,
      labels: options.labels,
      milestone: options.milestone,
      assignee_id: options.assigneeId || undefined,
      author_id: options.authorId || undefined,
      search: options.search,
      scope: options.scope,
      order_by: options.orderBy,
      sort: options.sort,
    });
    return this.paginatedRequest<GitLabIssue>(
      `${this.projectPath(projectId)}/issues${query}`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific issue.
   */
  async getIssue(
    projectId: string | number,
    issueIid: number
  ): Promise<GitLabIssue> {
    return this.request<GitLabIssue>(
      `${this.projectPath(projectId)}/issues/${issueIid}`
    );
  }

  /**
   * Update an issue.
   */
  async updateIssue(
    projectId: string | number,
    issueIid: number,
    updates: {
      title?: string;
      description?: string;
      assigneeIds?: number[];
      labels?: string;
      stateEvent?: "close" | "reopen";
      milestoneId?: number | null;
      dueDate?: string | null;
      confidential?: boolean;
      weight?: number | null;
    }
  ): Promise<GitLabIssue> {
    const body = this.compactBody({
      title: updates.title,
      description: updates.description,
      assignee_ids: updates.assigneeIds,
      labels: updates.labels,
      state_event: updates.stateEvent,
      milestone_id: updates.milestoneId,
      due_date: updates.dueDate,
      confidential: updates.confidential,
      weight: updates.weight,
    });

    return this.request<GitLabIssue>(
      `${this.projectPath(projectId)}/issues/${issueIid}`,
      { method: "PUT", body: JSON.stringify(body) },
      `Issue #${issueIid}`
    );
  }

  /**
   * Close an issue.
   */
  async closeIssue(
    projectId: string | number,
    issueIid: number
  ): Promise<GitLabIssue> {
    return this.updateIssue(projectId, issueIid, { stateEvent: "close" });
  }

  /**
   * Reopen an issue.
   */
  async reopenIssue(
    projectId: string | number,
    issueIid: number
  ): Promise<GitLabIssue> {
    return this.updateIssue(projectId, issueIid, { stateEvent: "reopen" });
  }

  // ============================================================================
  // MERGE REQUEST DISCUSSIONS & NOTES
  // ============================================================================

  /**
   * List discussions on a merge request.
   */
  async listMRDiscussions(
    projectId: string | number,
    mrIid: number,
    options: { page?: number; perPage?: number } = {}
  ): Promise<PaginatedResponse<GitLabDiscussion>> {
    return this.paginatedRequest<GitLabDiscussion>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/discussions`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific discussion.
   */
  async getMRDiscussion(
    projectId: string | number,
    mrIid: number,
    discussionId: string
  ): Promise<GitLabDiscussion> {
    return this.request<GitLabDiscussion>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/discussions/${discussionId}`
    );
  }

  /**
   * Resolve or unresolve a discussion thread on a merge request.
   */
  async resolveMRDiscussion(
    projectId: string | number,
    mrIid: number,
    discussionId: string,
    resolved: boolean
  ): Promise<GitLabDiscussion> {
    return this.request<GitLabDiscussion>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/discussions/${discussionId}`,
      { method: "PUT", body: JSON.stringify({ resolved }) },
      `Discussion ${discussionId} on MR !${mrIid}`
    );
  }

  /**
   * List notes (comments) on a merge request.
   */
  async listMRNotes(
    projectId: string | number,
    mrIid: number,
    options: {
      sort?: "asc" | "desc";
      orderBy?: "created_at" | "updated_at";
      page?: number;
      perPage?: number;
    } = {}
  ): Promise<PaginatedResponse<GitLabNote>> {
    const query = this.buildQuery({
      sort: options.sort,
      order_by: options.orderBy,
    });
    return this.paginatedRequest<GitLabNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/notes${query}`,
      options.page,
      options.perPage
    );
  }

  /**
   * Get a specific note.
   */
  async getMRNote(
    projectId: string | number,
    mrIid: number,
    noteId: number
  ): Promise<GitLabNote> {
    return this.request<GitLabNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/notes/${noteId}`
    );
  }

  // ============================================================================
  // MERGE REQUEST DRAFT NOTES (queued review comments)
  // ============================================================================

  async listMRDraftNotes(
    projectId: string | number,
    mrIid: number
  ): Promise<GitLabDraftNote[]> {
    return this.request<GitLabDraftNote[]>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/draft_notes`
    );
  }

  async getMRDraftNote(
    projectId: string | number,
    mrIid: number,
    draftNoteId: number
  ): Promise<GitLabDraftNote> {
    return this.request<GitLabDraftNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/draft_notes/${draftNoteId}`
    );
  }

  async createMRDraftNote(
    projectId: string | number,
    mrIid: number,
    params: {
      note: string;
      commitId?: string;
      inReplyToDiscussionId?: string;
      resolveDiscussion?: boolean;
      position?: GitLabDraftNotePosition;
    }
  ): Promise<GitLabDraftNote> {
    const form = new URLSearchParams();
    form.append("note", params.note);
    if (params.commitId !== undefined) form.append("commit_id", params.commitId);
    if (params.inReplyToDiscussionId !== undefined)
      form.append("in_reply_to_discussion_id", params.inReplyToDiscussionId);
    if (params.resolveDiscussion !== undefined)
      form.append("resolve_discussion", String(params.resolveDiscussion));
    if (params.position) appendPositionFormFields(form, params.position);

    return this.formRequest<GitLabDraftNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/draft_notes`,
      "POST",
      form
    );
  }

  async updateMRDraftNote(
    projectId: string | number,
    mrIid: number,
    draftNoteId: number,
    params: { note?: string; resolveDiscussion?: boolean; position?: GitLabDraftNotePosition }
  ): Promise<GitLabDraftNote> {
    const form = new URLSearchParams();
    if (params.note !== undefined) form.append("note", params.note);
    if (params.resolveDiscussion !== undefined)
      form.append("resolve_discussion", String(params.resolveDiscussion));
    if (params.position) appendPositionFormFields(form, params.position);

    return this.formRequest<GitLabDraftNote>(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/draft_notes/${draftNoteId}`,
      "PUT",
      form
    );
  }

  async deleteMRDraftNote(
    projectId: string | number,
    mrIid: number,
    draftNoteId: number
  ): Promise<void> {
    return this.voidRequest(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/draft_notes/${draftNoteId}`,
      { method: "DELETE" },
      `Draft note ${draftNoteId} on MR !${mrIid}`
    );
  }

  async publishMRDraftNote(
    projectId: string | number,
    mrIid: number,
    draftNoteId: number
  ): Promise<void> {
    return this.voidRequest(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/draft_notes/${draftNoteId}/publish`,
      { method: "PUT" },
      `Draft note ${draftNoteId} on MR !${mrIid}`
    );
  }

  async bulkPublishMRDraftNotes(
    projectId: string | number,
    mrIid: number
  ): Promise<void> {
    return this.voidRequest(
      `${this.projectPath(projectId)}/merge_requests/${mrIid}/draft_notes/bulk_publish`,
      { method: "POST" }
    );
  }

  // ============================================================================
  // PIPELINE ACTIONS
  // ============================================================================

  /**
   * Trigger a new pipeline on a branch or tag.
   */
  async createPipeline(
    projectId: string | number,
    ref: string,
    variables?: Array<{ key: string; value: string; variableType?: string }>
  ): Promise<GitLabPipelineDetailed> {
    const body = this.compactBody({
      ref,
      variables:
        variables && variables.length > 0
          ? variables.map((v) => ({
              key: v.key,
              value: v.value,
              variable_type: v.variableType ?? "env_var",
            }))
          : undefined,
    });
    return this.request<GitLabPipelineDetailed>(
      `${this.projectPath(projectId)}/pipeline`,
      { method: "POST", body: JSON.stringify(body) }
    );
  }

  /**
   * Retry failed jobs in a pipeline.
   */
  async retryPipeline(
    projectId: string | number,
    pipelineId: number
  ): Promise<GitLabPipelineDetailed> {
    return this.request<GitLabPipelineDetailed>(
      `${this.projectPath(projectId)}/pipelines/${pipelineId}/retry`,
      { method: "POST" }
    );
  }

  /**
   * Cancel a running pipeline.
   */
  async cancelPipeline(
    projectId: string | number,
    pipelineId: number
  ): Promise<GitLabPipelineDetailed> {
    return this.request<GitLabPipelineDetailed>(
      `${this.projectPath(projectId)}/pipelines/${pipelineId}/cancel`,
      { method: "POST" }
    );
  }

  /**
   * Delete a pipeline.
   */
  async deletePipeline(
    projectId: string | number,
    pipelineId: number
  ): Promise<void> {
    return this.voidRequest(
      `${this.projectPath(projectId)}/pipelines/${pipelineId}`,
      { method: "DELETE" }
    );
  }

  // LABELS
  // ============================================================================

  /**
   * Search labels in a project.
   */
  async searchLabels(
    projectId: string | number,
    options: { search?: string; page?: number; perPage?: number } = {}
  ): Promise<PaginatedResponse<GitLabLabel>> {
    const query = this.buildQuery({ search: options.search });
    return this.paginatedRequest<GitLabLabel>(
      `${this.projectPath(projectId)}/labels${query}`,
      options.page ?? 1,
      options.perPage ?? 50
    );
  }

  // COMPARE / DIFF
  // ============================================================================

  /**
   * Compare two branches, tags, or commits.
   */
  async compare(
    projectId: string | number,
    from: string,
    to: string,
    options: { straight?: boolean } = {}
  ): Promise<{
    commit: GitLabCommit;
    commits: GitLabCommit[];
    diffs: GitLabCommitDiff[];
    compareTimeout: boolean;
    compareSameRef: boolean;
  }> {
    const params = new URLSearchParams({
      from,
      to,
    });
    if (options.straight) params.append("straight", "true");

    return this.request(
      `${this.projectPath(projectId)}/repository/compare?${params.toString()}`
    );
  }

  // ============================================================================
  // ACCESS TOKENS
  // ============================================================================

  /**
   * Get the currently authenticated user.
   */
  async getCurrentUser(): Promise<GitLabUser> {
    return this.request<GitLabUser>("/user");
  }

  /**
   * Create a project access token.
   *
   * Requires Owner (or Maintainer) on the project. The returned token's
   * `token` field is the secret and is shown only once.
   */
  async createProjectAccessToken(
    projectId: string | number,
    options: {
      name: string;
      scopes: string[];
      accessLevel?: number;
      expiresAt?: string;
    }
  ): Promise<GitLabAccessToken> {
    const body = this.compactBody({
      name: options.name,
      scopes: options.scopes,
      access_level: options.accessLevel,
      expires_at: options.expiresAt || undefined,
    });

    return this.request<GitLabAccessToken>(
      `${this.projectPath(projectId)}/access_tokens`,
      { method: "POST", body: JSON.stringify(body) }
    );
  }

  /**
   * Create a personal access token for a user.
   *
   * Uses the admin endpoint `POST /users/:user_id/personal_access_tokens`,
   * which requires administrator privileges. The returned `token` field is
   * the secret and is shown only once.
   */
  async createPersonalAccessToken(
    userId: number,
    options: {
      name: string;
      scopes: string[];
      expiresAt?: string;
      description?: string;
    }
  ): Promise<GitLabAccessToken> {
    const body = this.compactBody({
      name: options.name,
      scopes: options.scopes,
      expires_at: options.expiresAt || undefined,
      description: options.description || undefined,
    });

    return this.request<GitLabAccessToken>(
      `/users/${userId}/personal_access_tokens`,
      { method: "POST", body: JSON.stringify(body) }
    );
  }
}

// Per-cwd client cache. In stdio mode there is typically one entry (the project
// CWD). In HTTP mode each session CWD gets its own entry so that different
// projects can use different tokens / GitLab instances.
const clients = new Map<string, GitLabClient>();

/**
 * Get or create a GitLab client for the current effective working directory.
 * The effective CWD is provided by AsyncLocalStorage (HTTP session) or
 * process.cwd() (stdio mode). See session-context.ts.
 */
export function getGitLabClient(): GitLabClient {
  const cwd = getEffectiveCwd();
  if (!clients.has(cwd)) {
    clients.set(cwd, new GitLabClient());
  }
  return clients.get(cwd)!;
}

/**
 * Reset the client cache (useful for testing or when credentials change).
 */
export function resetGitLabClient(): void {
  clients.clear();
}
