/**
 * Utility functions for GitLab MCP server.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getEffectiveCwd } from "./session-context.js";

/**
 * Zod schema for numeric parameters that accepts both string and number inputs.
 * Uses transform (not pipe) to avoid generating conflicting allOf constraints in JSON Schema.
 * z.union().pipe(z.coerce.number()) produces allOf:[{type:[string,number]},{type:number}]
 * which resolves to just {type:number} — still rejecting strings at schema validation time.
 * This produces {type:[number,string]} which correctly accepts both.
 */
export const numParam = () =>
  z.union([z.number(), z.string()])
    .transform((val) => typeof val === "string" ? Number(val) : val);

// MCP server instance for logging
let mcpServer: McpServer | null = null;

// Per-cwd git context cache (keyed by resolved working directory)
const gitContextCache = new Map<string, GitContext | null>();

/**
 * Set the MCP server instance for logging.
 */
export function setMcpServer(server: McpServer): void {
  mcpServer = server;
}

/**
 * Send a debug log message via MCP protocol.
 */
export function debug(message: string): void {
  if (mcpServer) {
    mcpServer
      .sendLoggingMessage({
        level: "debug",
        logger: "gitlab",
        data: message,
      })
      .catch(() => {
        // Ignore errors during logging
      });
  }
}

/**
 * Convert snake_case object keys to camelCase recursively.
 */
export function snakeToCamel<T>(obj: unknown): T {
  if (obj === null || obj === undefined) {
    return obj as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => snakeToCamel(item)) as T;
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
        letter.toUpperCase()
      );
      result[camelKey] = snakeToCamel(value);
    }
    return result as T;
  }

  return obj as T;
}

/**
 * Truncate text to a maximum length.
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const truncatedLength = maxLength - 100;
  const truncated = text.slice(0, truncatedLength);
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint =
    lastNewline > truncatedLength * 0.8 ? lastNewline : truncatedLength;
  return `${text.slice(0, cutPoint)}\n\n... [TRUNCATED - ${text.length - cutPoint} more characters] ...`;
}

/**
 * Extract lines from text with optional line range and limit.
 * Similar to Claude's native Read tool behavior.
 */
export function extractLines(
  text: string,
  options: {
    startLine?: number;  // 1-indexed, inclusive
    endLine?: number;    // 1-indexed, inclusive
    maxLines?: number;   // Maximum lines to return
  } = {}
): { content: string; totalLines: number; returnedRange: string } {
  const lines = text.split("\n");
  const totalLines = lines.length;

  // Default to start of file
  let start = Math.max(1, options.startLine ?? 1);
  let end = options.endLine ?? totalLines;

  // Apply maxLines limit
  if (options.maxLines && options.maxLines > 0) {
    end = Math.min(end, start + options.maxLines - 1);
  }

  // Clamp to valid range
  start = Math.min(start, totalLines);
  end = Math.min(end, totalLines);

  // Extract lines (convert from 1-indexed to 0-indexed)
  const selectedLines = lines.slice(start - 1, end);
  const content = selectedLines.join("\n");

  const returnedRange = start === end
    ? `line ${start}`
    : `lines ${start}-${end}`;

  return { content, totalLines, returnedRange };
}

/**
 * Format a date string to a human-readable format.
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Error classes for better error handling.
 */
export class GitLabError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "GitLabError";
  }
}

export class ConfigurationError extends GitLabError {
  constructor(message: string) {
    super(message, undefined, "CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
  }
}

export class NotFoundError extends GitLabError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class AuthenticationError extends GitLabError {
  constructor() {
    super(
      "Authentication failed. Check your GITLAB_TOKEN.",
      401,
      "AUTHENTICATION_ERROR"
    );
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends GitLabError {
  constructor(retryAfter?: number) {
    super(
      `Rate limit exceeded${retryAfter ? `. Retry after ${retryAfter} seconds` : ""}`,
      429,
      "RATE_LIMIT"
    );
    this.name = "RateLimitError";
  }
}

// ============================================================================
// GIT CONTEXT DETECTION
// ============================================================================

export interface GitContext {
  /** GitLab host (e.g., "gitlab.com" or "gitlab.mycompany.com") */
  host: string;
  /** Full URL to GitLab instance (e.g., "https://gitlab.com") */
  baseUrl: string;
  /** Project path (e.g., "mygroup/myproject") */
  projectPath: string;
  /** Current branch name */
  currentBranch: string | null;
  /** Working directory where .git was found */
  gitRoot: string;
}

/**
 * Parse a git remote URL and extract host and project path.
 * Supports SSH and HTTPS URLs:
 * - git@gitlab.com:group/project.git
 * - ssh://git@gitlab.com/group/project.git
 * - https://gitlab.com/group/project.git
 * - https://gitlab.com/group/subgroup/project.git
 */
export function parseGitRemoteUrl(url: string): { host: string; projectPath: string } | null {
  // SSH format: git@gitlab.com:group/project.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      host: sshMatch[1],
      projectPath: sshMatch[2],
    };
  }

  // SSH URL format: ssh://git@gitlab.com/group/project.git
  const sshUrlMatch = url.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshUrlMatch) {
    return {
      host: sshUrlMatch[1],
      projectPath: sshUrlMatch[2],
    };
  }

  // HTTPS format: https://gitlab.com/group/project.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      host: httpsMatch[1],
      projectPath: httpsMatch[2],
    };
  }

  return null;
}

/**
 * Find the git root directory starting from a given path.
 */
export function findGitRoot(startPath: string = getEffectiveCwd()): string | null {
  let currentPath = path.resolve(startPath);

  while (currentPath !== "/") {
    const gitDir = path.join(currentPath, ".git");
    if (fs.existsSync(gitDir)) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }

  return null;
}

/**
 * Get the origin remote URL from git config.
 */
export function getGitRemoteUrl(gitRoot: string, remoteName: string = "origin"): string | null {
  try {
    const result = execSync(`git -C "${gitRoot}" remote get-url ${remoteName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(gitRoot: string): string | null {
  try {
    const result = execSync(`git -C "${gitRoot}" rev-parse --abbrev-ref HEAD`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Detect GitLab context from the current working directory's git config.
 */
export function detectGitContext(workingDir: string = process.cwd()): GitContext | null {
  const gitRoot = findGitRoot(workingDir);
  if (!gitRoot) {
    debug("No .git directory found");
    return null;
  }

  const remoteUrl = getGitRemoteUrl(gitRoot);
  if (!remoteUrl) {
    debug("No origin remote configured");
    return null;
  }

  const parsed = parseGitRemoteUrl(remoteUrl);
  if (!parsed) {
    debug(`Could not parse remote URL: ${remoteUrl}`);
    return null;
  }

  const currentBranch = getCurrentBranch(gitRoot);

  const normalizedHost = parsed.host.endsWith(".gitlab.com") ? "gitlab.com" : parsed.host;

  const context: GitContext = {
    host: normalizedHost,
    baseUrl: `https://${normalizedHost}`,
    projectPath: parsed.projectPath,
    currentBranch,
    gitRoot,
  };

  debug(`Detected git context: ${JSON.stringify(context)}`);
  return context;
}

/**
 * Get cached git context or detect it.
 * Uses the effective CWD from AsyncLocalStorage (HTTP session) or process.cwd() (stdio).
 */
export function getGitContext(workingDir?: string): GitContext | null {
  const cwd = workingDir ?? getEffectiveCwd();
  if (!gitContextCache.has(cwd)) {
    gitContextCache.set(cwd, detectGitContext(cwd));
  }
  return gitContextCache.get(cwd) ?? null;
}

/**
 * Reset the git context cache.
 */
export function resetGitContext(): void {
  gitContextCache.clear();
}

// ============================================================================
// NETRC PARSING
// ============================================================================

export interface NetrcEntry {
  machine: string;
  login: string;
  password: string;
}

/**
 * Parse ~/.netrc file to find credentials for a host.
 * Format:
 *   machine gitlab.com
 *   login username
 *   password token
 */
export function parseNetrc(): Map<string, NetrcEntry> {
  const entries = new Map<string, NetrcEntry>();
  const netrcPath = path.join(process.env.HOME || "", ".netrc");

  if (!fs.existsSync(netrcPath)) {
    return entries;
  }

  try {
    const content = fs.readFileSync(netrcPath, "utf-8");
    const lines = content.split("\n");

    let currentEntry: Partial<NetrcEntry> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Handle both multi-line and single-line formats
      const tokens = trimmed.split(/\s+/);

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token === "machine" && tokens[i + 1]) {
          // Save previous entry if complete
          if (currentEntry.machine && currentEntry.login && currentEntry.password) {
            entries.set(currentEntry.machine, currentEntry as NetrcEntry);
          }
          currentEntry = { machine: tokens[++i] };
        } else if (token === "login" && tokens[i + 1]) {
          currentEntry.login = tokens[++i];
        } else if (token === "password" && tokens[i + 1]) {
          currentEntry.password = tokens[++i];
        }
      }
    }

    // Save last entry
    if (currentEntry.machine && currentEntry.login && currentEntry.password) {
      entries.set(currentEntry.machine, currentEntry as NetrcEntry);
    }

    debug(`Parsed ${entries.size} entries from .netrc`);
  } catch (e) {
    debug(`Failed to parse .netrc: ${e}`);
  }

  return entries;
}

/**
 * Get token for a GitLab host from .netrc.
 */
export function getTokenFromNetrc(host: string): string | null {
  const entries = parseNetrc();
  const entry = entries.get(host);
  return entry?.password || null;
}

/**
 * Build a standardized MCP tool error response.
 * Includes isError flag and a message telling the LLM to inform the user.
 * `sourceFile` is optional; when omitted a generic base path is used.
 * Existing 3-arg call sites (e.g. mcpToolError("name", "mr-tools.ts", e)) remain valid.
 */
export function mcpToolError(toolName: string, sourceFile: string | undefined, e: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const msg = e instanceof GitLabError ? e.message : e instanceof Error ? e.message : String(e);
  const location = sourceFile
    ? `mcp-servers/gitlab/src/tools/${sourceFile}`
    : `mcp-servers/gitlab/src/tools/`;
  return {
    content: [{
      type: "text",
      text: `MCP tool "${toolName}" failed: ${msg}\n\nPlease inform the user of this error so they can investigate and fix it in the gitlab MCP server source at ${location}`,
    }],
    isError: true,
  };
}

// ============================================================================
// TRUNCATION CONSTANTS (F-low magic numbers)
// ============================================================================

/** Max chars for MR change diff output (mr-tools: gitlab_get_merge_request changes). */
export const MAX_DIFF_CHARS = 3000;

/** Max chars for commit diff output (repo-tools: gitlab_get_commit). */
export const MAX_COMMIT_DIFF_CHARS = 2000;

/** Max chars for issue/MR description (issue-tools / mr-tools description fields). */
export const MAX_DESCRIPTION_CHARS = 5000;

/** Max chars for file content output (repo-tools: gitlab_get_file). */
export const MAX_FILE_CHARS = 50000;

/** Max chars for job log output (pipeline-tools: gitlab_get_job_log). */
export const MAX_LOG_CHARS = 50000;

/**
 * Get token from .gitlab-token file in the git root.
 */
export function getTokenFromFile(gitRoot: string): string | null {
  const tokenPath = path.join(gitRoot, ".gitlab-token");

  if (!fs.existsSync(tokenPath)) {
    return null;
  }

  try {
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    if (token) {
      debug(`Using token from .gitlab-token file in ${gitRoot}`);
      return token;
    }
  } catch (e) {
    debug(`Failed to read .gitlab-token: ${e}`);
  }

  return null;
}
