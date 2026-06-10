/**
 * GitLab merge request tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { formatDate, truncateText, numParam, mcpToolError, MAX_DIFF_CHARS } from "../utils.js";
import { resolveProject, formatMergeRequest, formatCommit, textResult, fileStatusLetter, projectParam, pageParams } from "./shared.js";

export function registerMRTools(server: McpServer): void {
  server.registerTool(
    "gitlab_list_merge_requests",
    {
      description: "List merge requests in a GitLab project.",
      inputSchema: {
        project: projectParam(),
        state: z
          .enum(["opened", "closed", "merged", "locked", "all"])
          .optional()
          .default("opened")
          .describe("Filter by MR state"),
        scope: z
          .enum(["created_by_me", "assigned_to_me", "all"])
          .optional()
          .describe("Filter by scope"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated list of labels"),
        search: z.string().optional().describe("Search in title and description"),
        source_branch: z.string().optional().describe("Filter by source branch"),
        target_branch: z.string().optional().describe("Filter by target branch"),
        order_by: z
          .enum(["created_at", "updated_at"])
          .optional()
          .default("updated_at")
          .describe("Order by field"),
        sort: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort order"),
        ...pageParams(20),
      },
    },
    async ({
      project,
      state,
      scope,
      labels,
      search,
      source_branch,
      target_branch,
      order_by,
      sort,
      page,
      per_page,
    }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listMergeRequests(projectId, {
          state,
          scope,
          labels: labels?.split(",").map((l) => l.trim()),
          search,
          sourceBranch: source_branch,
          targetBranch: target_branch,
          orderBy: order_by,
          sort,
          page,
          perPage: per_page,
        });

        const lines = [
          `Merge Requests in ${projectId} (${state || "opened"})`,
          `Page ${result.page}/${result.totalPages}, total: ${result.total}`,
          "",
        ];

        for (const mr of result.data) {
          lines.push(formatMergeRequest(mr));
          lines.push("");
        }

        if (result.nextPage) {
          lines.push(`Use page=${result.nextPage} to see more results.`);
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_list_merge_requests", "mr-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_merge_request",
    {
      description: "Get details of a specific merge request.",
      inputSchema: {
        project: projectParam(),
        mr_iid: numParam().describe("MR IID"),
      },
    },
    async ({ project, mr_iid }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const mr = await client.getMergeRequest(projectId, mr_iid);

        const lines = [
          `Merge Request !${mr.iid}: ${mr.title}`,
          "",
          `State: ${mr.state}${mr.draft ? " (draft)" : ""}`,
          `Author: @${mr.author.username} (${mr.author.name})`,
          `Branch: ${mr.sourceBranch} -> ${mr.targetBranch}`,
          "",
        ];

        if (mr.assignee) {
          lines.push(`Assignee: @${mr.assignee.username}`);
        }
        if (mr.reviewers.length > 0) {
          lines.push(
            `Reviewers: ${mr.reviewers.map((r) => `@${r.username}`).join(", ")}`
          );
        }
        if (mr.labels.length > 0) {
          lines.push(`Labels: ${mr.labels.join(", ")}`);
        }
        if (mr.milestone) {
          lines.push(`Milestone: ${mr.milestone.title}`);
        }

        lines.push("");
        lines.push(`Created: ${formatDate(mr.createdAt)}`);
        lines.push(`Updated: ${formatDate(mr.updatedAt)}`);

        if (mr.mergedAt) {
          lines.push(`Merged: ${formatDate(mr.mergedAt)} by @${mr.mergedBy?.username}`);
        }
        if (mr.closedAt) {
          lines.push(`Closed: ${formatDate(mr.closedAt)} by @${mr.closedBy?.username}`);
        }

        lines.push("");
        lines.push(`Merge Status: ${mr.mergeStatus}`);
        lines.push(`Has Conflicts: ${mr.hasConflicts ? "Yes" : "No"}`);
        lines.push(`Comments: ${mr.userNotesCount}`);
        if (mr.changesCount) {
          lines.push(`Files Changed: ${mr.changesCount}`);
        }

        lines.push("");
        lines.push(`URL: ${mr.webUrl}`);

        if (mr.description) {
          lines.push("");
          lines.push("Description:");
          lines.push(mr.description);
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_get_merge_request", "mr-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_merge_request_changes",
    {
      description: "Get the diff/changes for a merge request.",
      inputSchema: {
        project: projectParam(),
        mr_iid: numParam().describe("MR IID"),
      },
    },
    async ({ project, mr_iid }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const changes = await client.getMergeRequestChanges(projectId, mr_iid);

        const lines = [
          `Changes for MR !${changes.iid}: ${changes.title}`,
          `Branch: ${changes.sourceBranch} -> ${changes.targetBranch}`,
          "",
        ];

        if (changes.overflow) {
          lines.push(
            "WARNING: Changes exceed the limit. Some files may be missing."
          );
          lines.push("");
        }

        for (const change of changes.changes) {
          const status = fileStatusLetter(change);

          lines.push(`[${status}] ${change.newPath}`);
          if (change.renamedFile && change.oldPath !== change.newPath) {
            lines.push(`    (renamed from ${change.oldPath})`);
          }
          lines.push(truncateText(change.diff, MAX_DIFF_CHARS));
          lines.push("");
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_get_merge_request_changes", "mr-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_merge_request_commits",
    {
      description: "List commits in a merge request.",
      inputSchema: {
        project: projectParam(),
        mr_iid: numParam().describe("MR IID"),
        ...pageParams(20),
      },
    },
    async ({ project, mr_iid, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.getMergeRequestCommits(projectId, mr_iid, {
          page,
          perPage: per_page,
        });

        const lines = [`Commits in MR !${mr_iid}:`, ""];

        for (const commit of result.data) {
          lines.push(formatCommit(commit));
          lines.push("");
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_get_merge_request_commits", "mr-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_create_merge_request",
    {
      description: "Create a new merge request. Shows a preview for user confirmation before creation.",
      inputSchema: {
        project: projectParam(),
        source_branch: z.string().describe("Source branch name"),
        target_branch: z.string().describe("Target branch name (usually 'main' or 'develop')"),
        title: z.string().describe("Merge request title"),
        description: z.string().optional().describe("Merge request description (supports Markdown)"),
        assignee_id: numParam().optional().describe("User ID to assign the MR to"),
        reviewer_ids: z.array(numParam()).optional().describe("List of user IDs to request review from"),
        labels: z.array(z.string()).optional().describe("List of label names to add"),
        milestone: z.string().optional().describe("Milestone title"),
        draft: z.boolean().optional().default(false).describe("Create as draft MR"),
        remove_source_branch: z.boolean().optional().default(true).describe("Remove source branch after merge"),
        squash: z.boolean().optional().default(false).describe("Squash commits on merge"),
        confirm: z.boolean().optional().default(false).describe("Set to true to confirm and create the MR (after reviewing the preview)"),
      },
    },
    async ({
      project,
      source_branch,
      target_branch,
      title,
      description,
      assignee_id,
      reviewer_ids,
      labels,
      milestone,
      draft,
      remove_source_branch,
      squash,
      confirm,
    }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);

        const reviewLines = [
          "Merge Request Preview:",
          "",
          `Title: ${title}`,
          `Source: ${source_branch} -> Target: ${target_branch}`,
        ];

        if (description) {
          reviewLines.push("");
          reviewLines.push("Description:");
          reviewLines.push(description);
        }

        if (assignee_id) {
          reviewLines.push(`\nAssignee ID: ${assignee_id}`);
        }

        if (reviewer_ids && reviewer_ids.length > 0) {
          reviewLines.push(`Reviewers: ${reviewer_ids.join(", ")}`);
        }

        if (labels && labels.length > 0) {
          reviewLines.push(`Labels: ${labels.join(", ")}`);
        }

        if (milestone) {
          reviewLines.push(`Milestone: ${milestone}`);
        }

        reviewLines.push("");
        reviewLines.push("Options:");
        reviewLines.push(`  Draft: ${draft ? "Yes" : "No"}`);
        reviewLines.push(`  Remove source branch: ${remove_source_branch ? "Yes" : "No"}`);
        reviewLines.push(`  Squash commits: ${squash ? "Yes" : "No"}`);

        if (!confirm) {
          reviewLines.push("");
          reviewLines.push("Review the details above.");
          reviewLines.push("To create this MR, call the tool again with confirm=true");

          return textResult(reviewLines);
        }

        reviewLines.push("");
        reviewLines.push("Creating merge request...");

        const mr = await client.createMergeRequest(projectId, {
          sourceBranch: source_branch,
          targetBranch: target_branch,
          title,
          description,
          assigneeId: assignee_id,
          reviewerIds: reviewer_ids,
          labels,
          milestone,
          draft,
          removeSourceBranch: remove_source_branch,
          squash,
        });

        const successLines = [
          "Merge request created successfully!",
          "",
          formatMergeRequest(mr),
        ];

        return textResult(successLines);
      } catch (e) {
        return mcpToolError("gitlab_create_merge_request", "mr-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_mr_pipelines",
    {
      description: "List pipelines associated with a merge request.",
      inputSchema: {
        project: projectParam(),
        mr_iid: numParam().describe("MR IID"),
        ...pageParams(10),
      },
    },
    async ({ project, mr_iid, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.getMergeRequestPipelines(projectId, mr_iid, {
          page,
          perPage: per_page,
        });

        const lines = [`Pipelines for MR !${mr_iid}:`, ""];

        for (const pipeline of result.data) {
          lines.push(`#${pipeline.id} (${pipeline.status})`);
          lines.push(`  SHA: ${pipeline.sha.slice(0, 8)}`);
          lines.push(`  Ref: ${pipeline.ref}`);
          lines.push(`  Source: ${pipeline.source}`);
          lines.push(`  Created: ${formatDate(pipeline.createdAt)}`);
          lines.push(`  URL: ${pipeline.webUrl}`);
          lines.push("");
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_get_mr_pipelines", "mr-tools.ts", e);
      }
    }
  );
}
