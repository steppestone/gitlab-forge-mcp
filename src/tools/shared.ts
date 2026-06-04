/**
 * Shared utilities for GitLab MCP tools.
 */

import { getGitLabClient } from "../api/gitlab.js";
import { ConfigurationError, formatDate } from "../utils.js";

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
