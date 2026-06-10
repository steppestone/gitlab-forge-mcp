/**
 * Shared utilities for GitLab MCP tools.
 */

import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { ConfigurationError, formatDate, numParam } from "../utils.js";

/**
 * Resolve project ID - use provided value or fall back to git context.
 */
export function resolveProject(project: string | undefined): string {
  if (project) {
    return project;
  }

  const client = getGitLabClient();
  const defaultProject = client.getDefaultProject();

  if (!defaultProject) {
    throw new ConfigurationError(
      "No project specified and could not detect from git remote. " +
        "Either provide a project parameter or run from a git repository with a GitLab origin."
    );
  }

  return defaultProject;
}

/**
 * Format a merge request for display.
 */
export function formatMergeRequest(mr: {
  iid: number;
  title: string;
  state: string;
  author: { username: string };
  sourceBranch: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  description?: string | null;
  draft?: boolean;
  labels?: string[];
  userNotesCount?: number;
}): string {
  const lines = [
    `!${mr.iid}: ${mr.title}`,
    `  State: ${mr.state}${mr.draft ? " (draft)" : ""}`,
    `  Author: @${mr.author.username}`,
    `  Branch: ${mr.sourceBranch} -> ${mr.targetBranch}`,
    `  Created: ${formatDate(mr.createdAt)}`,
    `  Updated: ${formatDate(mr.updatedAt)}`,
  ];

  if (mr.labels && mr.labels.length > 0) {
    lines.push(`  Labels: ${mr.labels.join(", ")}`);
  }

  if (mr.userNotesCount !== undefined) {
    lines.push(`  Comments: ${mr.userNotesCount}`);
  }

  lines.push(`  URL: ${mr.webUrl}`);

  return lines.join("\n");
}

/**
 * Format a commit for display.
 */
export function formatCommit(commit: {
  shortId: string;
  title: string;
  authorName: string;
  authoredDate: string;
  message?: string;
}): string {
  return [
    `${commit.shortId}: ${commit.title}`,
    `  Author: ${commit.authorName}`,
    `  Date: ${formatDate(commit.authoredDate)}`,
  ].join("\n");
}

/**
 * Check if a discussion is resolved.
 */
export function isDiscussionResolved(discussion: {
  notes: Array<{ resolvable?: boolean; resolved?: boolean }>;
}): boolean {
  const resolvableNotes = discussion.notes.filter((n) => n.resolvable);
  if (resolvableNotes.length === 0) return false;
  return resolvableNotes.every((n) => n.resolved);
}

/**
 * Format a discussion/comment thread (compact format).
 */
export function formatDiscussion(
  discussion: {
    id: string;
    individualNote: boolean;
    notes: Array<{
      id: number;
      body: string;
      author: { username: string };
      createdAt: string;
      system: boolean;
      resolved?: boolean;
    }>;
  },
  includeSystemNotes: boolean = false
): string {
  const lines: string[] = [];

  for (const note of discussion.notes) {
    if (note.system && !includeSystemNotes) continue;
    if (note.system) {
      lines.push(`[sys] ${note.body}`);
    } else {
      lines.push(`@${note.author.username}: ${note.body}`);
    }
  }

  return lines.join("\n");
}

// ============================================================================
// PRESENTATION HELPERS (F8, F9, F12, F14)
// ============================================================================

/**
 * MCP text-content result envelope.
 * Accepts a pre-joined string or an array of lines (joined with "\n").
 */
export function textResult(text: string | string[]): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: Array.isArray(text) ? text.join("\n") : text }],
  };
}

/**
 * Single-letter git status for a diff/change entry.
 * Precedence: newFile → deletedFile → renamedFile → Modified.
 */
export function fileStatusLetter(
  change: { newFile?: boolean; deletedFile?: boolean; renamedFile?: boolean }
): "A" | "D" | "R" | "M" {
  return change.newFile ? "A" : change.deletedFile ? "D" : change.renamedFile ? "R" : "M";
}

/**
 * Long-form git status label.
 * Precedence: newFile → deletedFile → renamedFile → Modified.
 */
export function fileStatusLabel(
  change: { newFile?: boolean; deletedFile?: boolean; renamedFile?: boolean }
): "Added" | "Deleted" | "Renamed" | "Modified" {
  return change.newFile
    ? "Added"
    : change.deletedFile
      ? "Deleted"
      : change.renamedFile
        ? "Renamed"
        : "Modified";
}

/**
 * Format a note/draft "position" as "path:line".
 * Uses newPath || oldPath and newLine ?? oldLine, with "?" fallbacks.
 * Returns "" if position is null/undefined so callers can conditionally push.
 * Mirrors discussion-tools / draft-note-tools logic.
 */
export function formatPositionRef(
  position:
    | {
        newPath?: string | null;
        oldPath?: string | null;
        newLine?: number | null;
        oldLine?: number | null;
      }
    | null
    | undefined
): string {
  if (position == null) return "";
  const file = position.newPath || position.oldPath || "?";
  const line = position.newLine ?? position.oldLine ?? "?";
  return `${file}:${line}`;
}

/**
 * Human duration from seconds.
 * - >= 60s: "Xm Ys"
 * - < 60s:  "Ys"
 * - falsy/undefined/null: returns `fallback` (default "N/A")
 *
 * NOTE: gitlab_list_pipelines previously rendered minutes-only (`${Math.round(d/60)}m`).
 * After migration it will gain seconds precision — an intentional minor improvement.
 * gitlab_get_job / list_pipeline_jobs used bare-seconds format (`${Math.round(d)}s`),
 * which is still produced here for durations < 60s.
 * Pass fallback="-" when migrating gitlab_list_pipelines.
 */
export function formatDuration(seconds: number | undefined | null, fallback = "N/A"): string {
  if (!seconds) return fallback;
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  return `${Math.round(seconds)}s`;
}

/**
 * Human byte size: MB if >= 1 MiB, else KB (toFixed(1)).
 * Matches existing pipeline-tools artifact formatting.
 */
export function formatBytes(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${(bytes / 1024).toFixed(1)}KB`;
}

/**
 * Reusable zod fragment factory for the `project` tool param (fresh instance each call).
 * Describe: "Project path/ID (default: current repo)"
 */
export function projectParam(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Project path/ID (default: current repo)");
}

/**
 * Reusable zod fragments for pagination (fresh instances each call).
 * Spread into inputSchema: `{ ...pageParams(20) }`.
 * @param perPageDefault - default per-page value (e.g. 20, 10, 50, 100)
 */
export function pageParams(perPageDefault = 20): {
  page: ReturnType<typeof numParam> extends infer N ? z.ZodDefault<z.ZodOptional<N & z.ZodTypeAny>> : never;
  per_page: ReturnType<typeof numParam> extends infer N ? z.ZodDefault<z.ZodOptional<N & z.ZodTypeAny>> : never;
} {
  return {
    page: numParam().optional().default(1).describe("Page") as never,
    per_page: numParam().optional().default(perPageDefault).describe("Per page") as never,
  };
}
