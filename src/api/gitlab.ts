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

    // Resolve base URL
    if (config?.baseUrl) {
      this.baseUrl = config.baseUrl;
    } else if (process.env.GITLAB_URL) {
      this.baseUrl = process.env.GITLAB_URL;
    } else if (this.gitContext) {
      this.baseUrl = this.gitContext.baseUrl;
      debug(`Using GitLab URL from git remote: ${this.baseUrl}`);
    } else {
      this.baseUrl = "https://gitlab.com";
    }

    // Remove trailing slash from baseUrl
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");

    // Extract host for netrc lookup — use hostname (not host) to exclude port numbers
    const host = new URL(this.baseUrl).hostname;

    // Resolve token
    if (config?.token) {
      this.token = config.token;
    } else if (this.gitContext) {
      // Try .gitlab-token file in git root first
      const fileToken = getTokenFromFile(this.gitContext.gitRoot);
      if (fileToken) {
        this.token = fileToken;
      } else if (process.env.GITLAB_TOKEN) {
        this.token = process.env.GITLAB_TOKEN;
      } else {
        // Try .netrc
        const netrcToken = getTokenFromNetrc(host);
        if (netrcToken) {
          this.token = netrcToken;
          debug(`Using token from .netrc for ${host}`);
        } else {
          this.token = "";
        }
      }
    } else if (process.env.GITLAB_TOKEN) {
      this.token = process.env.GITLAB_TOKEN;
    } else {
      // Try .netrc
      const netrcToken = getTokenFromNetrc(host);
      if (netrcToken) {
        this.token = netrcToken;
        debug(`Using token from .netrc for ${host}`);
      } else {
        this.token = "";
      }
    }

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
   * Make an authenticated request to the GitLab API.
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
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

    if (!response.ok) {
      const errorBody = await response.text();
      debug(`GitLab API error: ${response.status} ${errorBody}`);

      switch (response.status) {
        case 401:
          throw new AuthenticationError();
        case 404:
          throw new NotFoundError("Resource");
        case 429:
          const retryAfter = response.headers.get("Retry-After");
          throw new RateLimitError(retryAfter ? parseInt(retryAfter) : undefined);
        default:
          throw new GitLabError(
            `GitLab API error: ${response.status} ${errorBody}`,
            response.status
          );
      }
    }

    const data = await response.json();
    return snakeToCamel<T>(data);
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

    if (!response.ok) {
      const errorBody = await response.text();
      debug(`GitLab API error: ${response.status} ${errorBody}`);

      switch (response.status) {
        case 401:
          throw new AuthenticationError();
        case 404:
          throw new NotFoundError("Resource");
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

    const data = await response.json();
    return snakeToCamel<T>(data);
  }

  /**
   * Make an authenticated request that returns no body (e.g. DELETE → 204).
   */
  private async voidRequest(
    endpoint: string,
    options: RequestInit = {}
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

    if (!response.ok) {
      const errorBody = await response.text();
      debug(`GitLab API error: ${response.status} ${errorBody}`);

      switch (response.status) {
        case 401:
          throw new AuthenticationError();
        case 404:
          throw new NotFoundError("Resource");
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

    if (!response.ok) {
      const errorBody = await response.text();
      throw new GitLabError(
        `GitLab API error: ${response.status} ${errorBody}`,
        response.status
      );
    }

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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabProject>(`/projects/${encodedId}`);
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
    const params = new URLSearchParams();
    if (options.search) params.append("search", options.search);
    if (options.owned) params.append("owned", "true");
    if (options.membership) params.append("membership", "true");

    const query = params.toString();
    return this.paginatedRequest<GitLabProject>(
      `/projects${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();
    if (options.search) params.append("search", options.search);

    const query = params.toString();
    return this.paginatedRequest<GitLabBranch>(
      `/projects/${encodedId}/repository/branches${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const encodedBranch = encodeURIComponent(branchName);
    return this.request<GitLabBranch>(
      `/projects/${encodedId}/repository/branches/${encodedBranch}`
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();
    if (options.refName) params.append("ref_name", options.refName);
    if (options.path) params.append("path", options.path);
    if (options.since) params.append("since", options.since);
    if (options.until) params.append("until", options.until);

    const query = params.toString();
    return this.paginatedRequest<GitLabCommit>(
      `/projects/${encodedId}/repository/commits${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabCommit>(
      `/projects/${encodedId}/repository/commits/${sha}`
    );
  }

  /**
   * Get the diff for a commit.
   */
  async getCommitDiff(
    projectId: string | number,
    sha: string
  ): Promise<GitLabCommitDiff[]> {
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabCommitDiff[]>(
      `/projects/${encodedId}/repository/commits/${sha}/diff`
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
    const encodedId = encodeURIComponent(String(projectId));
    const encodedPath = encodeURIComponent(filePath);
    return this.request<GitLabFile>(
      `/projects/${encodedId}/repository/files/${encodedPath}?ref=${encodeURIComponent(ref)}`
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
    const encodedId = encodeURIComponent(String(projectId));
    const encodedPath = encodeURIComponent(filePath);
    const url = `${this.baseUrl}/api/v4/projects/${encodedId}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`;

    const response = await fetch(url, {
      headers: {
        "PRIVATE-TOKEN": this.token,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(`File ${filePath}`);
      }
      throw new GitLabError(
        `Failed to get file: ${response.status}`,
        response.status
      );
    }

    return response.text();
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();
    if (options.path) params.append("path", options.path);
    if (options.ref) params.append("ref", options.ref);
    if (options.recursive) params.append("recursive", "true");

    const query = params.toString();
    return this.paginatedRequest<GitLabTreeItem>(
      `/projects/${encodedId}/repository/tree${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();

    if (options.state) params.append("state", options.state);
    if (options.scope) params.append("scope", options.scope);
    if (options.authorId) params.append("author_id", String(options.authorId));
    if (options.assigneeId) params.append("assignee_id", String(options.assigneeId));
    if (options.reviewerId) params.append("reviewer_id", String(options.reviewerId));
    if (options.labels) params.append("labels", options.labels.join(","));
    if (options.milestone) params.append("milestone", options.milestone);
    if (options.search) params.append("search", options.search);
    if (options.sourceBranch) params.append("source_branch", options.sourceBranch);
    if (options.targetBranch) params.append("target_branch", options.targetBranch);
    if (options.orderBy) params.append("order_by", options.orderBy);
    if (options.sort) params.append("sort", options.sort);

    const query = params.toString();
    return this.paginatedRequest<GitLabMergeRequest>(
      `/projects/${encodedId}/merge_requests${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabMergeRequest>(
      `/projects/${encodedId}/merge_requests/${mrIid}`
    );
  }

  /**
   * Get merge request changes (diff).
   */
  async getMergeRequestChanges(
    projectId: string | number,
    mrIid: number
  ): Promise<GitLabMRChanges> {
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabMRChanges>(
      `/projects/${encodedId}/merge_requests/${mrIid}/changes`
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.paginatedRequest<GitLabCommit>(
      `/projects/${encodedId}/merge_requests/${mrIid}/commits`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.paginatedRequest<GitLabPipeline>(
      `/projects/${encodedId}/merge_requests/${mrIid}/pipelines`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const body: Record<string, unknown> = {
      source_branch: options.sourceBranch,
      target_branch: options.targetBranch,
      title: options.title,
    };

    if (options.description) body.description = options.description;
    if (options.assigneeId) body.assignee_id = options.assigneeId;
    if (options.reviewerIds && options.reviewerIds.length > 0) {
      body.reviewer_ids = options.reviewerIds;
    }
    if (options.labels && options.labels.length > 0) {
      body.labels = options.labels.join(",");
    }
    if (options.milestone) body.milestone = options.milestone;
    if (options.draft) body.draft = options.draft;
    if (options.removeSourceBranch !== undefined) {
      body.remove_source_branch = options.removeSourceBranch;
    }
    if (options.squash !== undefined) body.squash = options.squash;

    return this.request<GitLabMergeRequest>(
      `/projects/${encodedId}/merge_requests`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();

    if (options.scope) params.append("scope", options.scope);
    if (options.status) params.append("status", options.status);
    if (options.ref) params.append("ref", options.ref);
    if (options.sha) params.append("sha", options.sha);
    if (options.yamlErrors !== undefined) params.append("yaml_errors", String(options.yamlErrors));
    if (options.username) params.append("username", options.username);
    if (options.orderBy) params.append("order_by", options.orderBy);
    if (options.sort) params.append("sort", options.sort);
    if (options.source) params.append("source", options.source);

    const query = params.toString();
    return this.paginatedRequest<GitLabPipeline>(
      `/projects/${encodedId}/pipelines${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabPipelineDetailed>(
      `/projects/${encodedId}/pipelines/${pipelineId}`
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();

    if (options.scope) params.append("scope[]", options.scope);
    if (options.includeRetried !== undefined) params.append("include_retried", String(options.includeRetried));

    const query = params.toString();
    return this.paginatedRequest<GitLabJob>(
      `/projects/${encodedId}/pipelines/${pipelineId}/jobs${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabJob>(`/projects/${encodedId}/jobs/${jobId}`);
  }

  /**
   * Get job log (trace).
   */
  async getJobLog(
    projectId: string | number,
    jobId: number
  ): Promise<string> {
    const encodedId = encodeURIComponent(String(projectId));
    const url = `${this.baseUrl}/api/v4/projects/${encodedId}/jobs/${jobId}/trace`;

    const response = await fetch(url, {
      headers: {
        "PRIVATE-TOKEN": this.token,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(`Job ${jobId}`);
      }
      throw new GitLabError(
        `Failed to get job log: ${response.status}`,
        response.status
      );
    }

    return response.text();
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();

    if (options.state) params.append("state", options.state);
    if (options.labels) params.append("labels", options.labels);
    if (options.milestone) params.append("milestone", options.milestone);
    if (options.assigneeId) params.append("assignee_id", String(options.assigneeId));
    if (options.authorId) params.append("author_id", String(options.authorId));
    if (options.search) params.append("search", options.search);
    if (options.scope) params.append("scope", options.scope);
    if (options.orderBy) params.append("order_by", options.orderBy);
    if (options.sort) params.append("sort", options.sort);

    const query = params.toString();
    return this.paginatedRequest<GitLabIssue>(
      `/projects/${encodedId}/issues${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabIssue>(
      `/projects/${encodedId}/issues/${issueIid}`
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
    const encodedId = encodeURIComponent(String(projectId));
    const body: Record<string, unknown> = {};

    if (updates.title !== undefined) body.title = updates.title;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.assigneeIds !== undefined) body.assignee_ids = updates.assigneeIds;
    if (updates.labels !== undefined) body.labels = updates.labels;
    if (updates.stateEvent !== undefined) body.state_event = updates.stateEvent;
    if (updates.milestoneId !== undefined) body.milestone_id = updates.milestoneId;
    if (updates.dueDate !== undefined) body.due_date = updates.dueDate;
    if (updates.confidential !== undefined) body.confidential = updates.confidential;
    if (updates.weight !== undefined) body.weight = updates.weight;

    const url = `${this.baseUrl}/api/v4/projects/${encodedId}/issues/${issueIid}`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(`Issue #${issueIid}`);
      }
      throw new GitLabError(
        `Failed to update issue: ${response.status}`,
        response.status
      );
    }

    const data = await response.json();
    return snakeToCamel<GitLabIssue>(data);
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.paginatedRequest<GitLabDiscussion>(
      `/projects/${encodedId}/merge_requests/${mrIid}/discussions`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabDiscussion>(
      `/projects/${encodedId}/merge_requests/${mrIid}/discussions/${discussionId}`
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
    const encodedId = encodeURIComponent(String(projectId));
    const url = `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests/${mrIid}/discussions/${discussionId}`;

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resolved }),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(`Discussion ${discussionId} on MR !${mrIid}`);
      }
      throw new GitLabError(
        `Failed to ${resolved ? "resolve" : "unresolve"} discussion: ${response.status}`,
        response.status
      );
    }

    const data = await response.json();
    return snakeToCamel<GitLabDiscussion>(data);
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();

    if (options.sort) params.append("sort", options.sort);
    if (options.orderBy) params.append("order_by", options.orderBy);

    const query = params.toString();
    return this.paginatedRequest<GitLabNote>(
      `/projects/${encodedId}/merge_requests/${mrIid}/notes${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabNote>(
      `/projects/${encodedId}/merge_requests/${mrIid}/notes/${noteId}`
    );
  }

  // ============================================================================
  // MERGE REQUEST DRAFT NOTES (queued review comments)
  // ============================================================================

  async listMRDraftNotes(
    projectId: string | number,
    mrIid: number
  ): Promise<GitLabDraftNote[]> {
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabDraftNote[]>(
      `/projects/${encodedId}/merge_requests/${mrIid}/draft_notes`
    );
  }

  async getMRDraftNote(
    projectId: string | number,
    mrIid: number,
    draftNoteId: number
  ): Promise<GitLabDraftNote> {
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabDraftNote>(
      `/projects/${encodedId}/merge_requests/${mrIid}/draft_notes/${draftNoteId}`
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
    const encodedId = encodeURIComponent(String(projectId));
    const form = new URLSearchParams();
    form.append("note", params.note);
    if (params.commitId !== undefined) form.append("commit_id", params.commitId);
    if (params.inReplyToDiscussionId !== undefined)
      form.append("in_reply_to_discussion_id", params.inReplyToDiscussionId);
    if (params.resolveDiscussion !== undefined)
      form.append("resolve_discussion", String(params.resolveDiscussion));
    if (params.position) appendPositionFormFields(form, params.position);

    return this.formRequest<GitLabDraftNote>(
      `/projects/${encodedId}/merge_requests/${mrIid}/draft_notes`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const form = new URLSearchParams();
    if (params.note !== undefined) form.append("note", params.note);
    if (params.resolveDiscussion !== undefined)
      form.append("resolve_discussion", String(params.resolveDiscussion));
    if (params.position) appendPositionFormFields(form, params.position);

    return this.formRequest<GitLabDraftNote>(
      `/projects/${encodedId}/merge_requests/${mrIid}/draft_notes/${draftNoteId}`,
      "PUT",
      form
    );
  }

  async deleteMRDraftNote(
    projectId: string | number,
    mrIid: number,
    draftNoteId: number
  ): Promise<void> {
    const encodedId = encodeURIComponent(String(projectId));
    const url = `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests/${mrIid}/draft_notes/${draftNoteId}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(`Draft note ${draftNoteId} on MR !${mrIid}`);
      }
      throw new GitLabError(
        `Failed to delete draft note: ${response.status}`,
        response.status
      );
    }
  }

  async publishMRDraftNote(
    projectId: string | number,
    mrIid: number,
    draftNoteId: number
  ): Promise<void> {
    const encodedId = encodeURIComponent(String(projectId));
    const url = `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests/${mrIid}/draft_notes/${draftNoteId}/publish`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundError(`Draft note ${draftNoteId} on MR !${mrIid}`);
      }
      throw new GitLabError(
        `Failed to publish draft note: ${response.status}`,
        response.status
      );
    }
  }

  async bulkPublishMRDraftNotes(
    projectId: string | number,
    mrIid: number
  ): Promise<void> {
    const encodedId = encodeURIComponent(String(projectId));
    const url = `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests/${mrIid}/draft_notes/bulk_publish`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": this.token,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new GitLabError(
        `Failed to bulk-publish draft notes: ${response.status}`,
        response.status
      );
    }
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
    const encodedId = encodeURIComponent(String(projectId));
    const body: Record<string, unknown> = { ref };
    if (variables && variables.length > 0) {
      body.variables = variables.map((v) => ({
        key: v.key,
        value: v.value,
        variable_type: v.variableType ?? "env_var",
      }));
    }
    return this.request<GitLabPipelineDetailed>(
      `/projects/${encodedId}/pipeline`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabPipelineDetailed>(
      `/projects/${encodedId}/pipelines/${pipelineId}/retry`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.request<GitLabPipelineDetailed>(
      `/projects/${encodedId}/pipelines/${pipelineId}/cancel`,
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
    const encodedId = encodeURIComponent(String(projectId));
    return this.voidRequest(
      `/projects/${encodedId}/pipelines/${pipelineId}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams();
    if (options.search) params.append("search", options.search);
    const query = params.toString();
    return this.paginatedRequest<GitLabLabel>(
      `/projects/${encodedId}/labels${query ? `?${query}` : ""}`,
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
    const encodedId = encodeURIComponent(String(projectId));
    const params = new URLSearchParams({
      from,
      to,
    });
    if (options.straight) params.append("straight", "true");

    return this.request(
      `/projects/${encodedId}/repository/compare?${params.toString()}`
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
