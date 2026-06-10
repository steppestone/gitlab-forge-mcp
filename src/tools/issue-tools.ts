/**
 * GitLab issue tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { formatDate, truncateText, numParam, mcpToolError, MAX_DESCRIPTION_CHARS } from "../utils.js";
import { resolveProject, textResult, projectParam, pageParams } from "./shared.js";

export function registerIssueTools(server: McpServer): void {
  server.registerTool(
    "gitlab_list_issues",
    {
      description: "List issues in a GitLab project.",
      inputSchema: {
        project: projectParam(),
        state: z
          .enum(["opened", "closed", "all"])
          .optional()
          .default("opened")
          .describe("Filter by issue state"),
        scope: z
          .enum(["created_by_me", "assigned_to_me", "all"])
          .optional()
          .describe("Filter by scope"),
        labels: z
          .string()
          .optional()
          .describe("Comma-separated list of labels"),
        milestone: z.string().optional().describe("Filter by milestone title"),
        assignee_id: numParam().optional().describe("Filter by assignee user ID"),
        author_id: numParam().optional().describe("Filter by author user ID"),
        search: z.string().optional().describe("Search in title and description"),
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
      milestone,
      assignee_id,
      author_id,
      search,
      order_by,
      sort,
      page,
      per_page,
    }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listIssues(projectId, {
          state,
          scope,
          labels,
          milestone,
          assigneeId: assignee_id,
          authorId: author_id,
          search,
          orderBy: order_by,
          sort,
          page,
          perPage: per_page,
        });

        const lines = [
          `Issues in ${projectId} (${state || "opened"})`,
          `Page ${result.page}/${result.totalPages}, total: ${result.total}`,
          "",
        ];

        for (const issue of result.data) {
          lines.push(
            `#${issue.iid}: ${issue.title}`,
            `  State: ${issue.state}`,
            `  Author: @${issue.author.username}`,
            `  Created: ${formatDate(issue.createdAt)}`,
            `  Updated: ${formatDate(issue.updatedAt)}`
          );

          if (issue.assignees && issue.assignees.length > 0) {
            lines.push(`  Assignees: ${issue.assignees.map((a) => `@${a.username}`).join(", ")}`);
          }

          if (issue.labels && issue.labels.length > 0) {
            lines.push(`  Labels: ${issue.labels.join(", ")}`);
          }

          if (issue.milestone) {
            lines.push(`  Milestone: ${issue.milestone.title}`);
          }

          if (issue.dueDate) {
            lines.push(`  Due: ${formatDate(issue.dueDate)}`);
          }

          lines.push(`  Comments: ${issue.userNotesCount}`);
          lines.push(`  URL: ${issue.webUrl}`);
          lines.push("");
        }

        if (result.nextPage) {
          lines.push(`Use page=${result.nextPage} to see more results.`);
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_list_issues", "issue-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_issue",
    {
      description: "Get details of a specific issue.",
      inputSchema: {
        project: projectParam(),
        issue_iid: numParam().describe("Issue IID"),
      },
    },
    async ({ project, issue_iid }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const issue = await client.getIssue(projectId, issue_iid);

        const lines = [
          `Issue #${issue.iid}: ${issue.title}`,
          `State: ${issue.state}`,
          `Author: @${issue.author.username}`,
          `Created: ${formatDate(issue.createdAt)}`,
          `Updated: ${formatDate(issue.updatedAt)}`,
        ];

        if (issue.closedAt) {
          lines.push(`Closed: ${formatDate(issue.closedAt)}`);
          if (issue.closedBy) {
            lines.push(`Closed by: @${issue.closedBy.username}`);
          }
        }

        if (issue.assignees && issue.assignees.length > 0) {
          lines.push(`Assignees: ${issue.assignees.map((a) => `@${a.username}`).join(", ")}`);
        }

        if (issue.labels && issue.labels.length > 0) {
          lines.push(`Labels: ${issue.labels.join(", ")}`);
        }

        if (issue.milestone) {
          lines.push(`Milestone: ${issue.milestone.title}`);
        }

        if (issue.dueDate) {
          lines.push(`Due Date: ${formatDate(issue.dueDate)}`);
        }

        if (issue.weight !== null) {
          lines.push(`Weight: ${issue.weight}`);
        }

        if (issue.confidential) {
          lines.push(`Confidential: Yes`);
        }

        lines.push(`Comments: ${issue.userNotesCount}`);
        lines.push(`URL: ${issue.webUrl}`);

        if (issue.description) {
          lines.push("");
          lines.push("Description:");
          lines.push(truncateText(issue.description, MAX_DESCRIPTION_CHARS));
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_get_issue", "issue-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_update_issue",
    {
      description: "Update an issue's title, description, assignees, labels, state, or milestone.",
      inputSchema: {
        project: projectParam(),
        issue_iid: numParam().describe("Issue IID"),
        title: z.string().optional().describe("New title for the issue"),
        description: z.string().optional().describe("New description for the issue"),
        assignee_ids: z.array(numParam()).optional().describe("Array of user IDs to assign"),
        labels: z.string().optional().describe("Comma-separated list of labels"),
        state_event: z
          .enum(["close", "reopen"])
          .optional()
          .describe("Change issue state: 'close' to close, 'reopen' to reopen"),
        milestone_id: numParam().optional().describe("Milestone ID (use null to remove)"),
        due_date: z.string().optional().describe("Due date in YYYY-MM-DD format (use null to remove)"),
        confidential: z.boolean().optional().describe("Set issue as confidential"),
        weight: numParam().optional().describe("Issue weight (use null to remove)"),
      },
    },
    async ({
      project,
      issue_iid,
      title,
      description,
      assignee_ids,
      labels,
      state_event,
      milestone_id,
      due_date,
      confidential,
      weight,
    }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);

        const updates: {
          title?: string;
          description?: string;
          assigneeIds?: number[];
          labels?: string;
          stateEvent?: "close" | "reopen";
          milestoneId?: number | null;
          dueDate?: string | null;
          confidential?: boolean;
          weight?: number | null;
        } = {};

        if (title !== undefined) updates.title = title;
        if (description !== undefined) updates.description = description;
        if (assignee_ids !== undefined) updates.assigneeIds = assignee_ids;
        if (labels !== undefined) updates.labels = labels;
        if (state_event !== undefined) updates.stateEvent = state_event;
        if (milestone_id !== undefined) updates.milestoneId = milestone_id;
        if (due_date !== undefined) updates.dueDate = due_date;
        if (confidential !== undefined) updates.confidential = confidential;
        if (weight !== undefined) updates.weight = weight;

        const issue = await client.updateIssue(projectId, issue_iid, updates);

        const lines = [
          `Updated issue #${issue.iid}`,
          `Title: ${issue.title}`,
          `State: ${issue.state}`,
          `URL: ${issue.webUrl}`,
        ];

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_update_issue", "issue-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_close_issue",
    {
      description: "Close an issue.",
      inputSchema: {
        project: projectParam(),
        issue_iid: numParam().describe("Issue IID"),
      },
    },
    async ({ project, issue_iid }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const issue = await client.closeIssue(projectId, issue_iid);

        return textResult(`Closed issue #${issue.iid}: ${issue.title}\nURL: ${issue.webUrl}`);
      } catch (e) {
        return mcpToolError("gitlab_close_issue", "issue-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_reopen_issue",
    {
      description: "Reopen a closed issue.",
      inputSchema: {
        project: projectParam(),
        issue_iid: numParam().describe("Issue IID"),
      },
    },
    async ({ project, issue_iid }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const issue = await client.reopenIssue(projectId, issue_iid);

        return textResult(`Reopened issue #${issue.iid}: ${issue.title}\nURL: ${issue.webUrl}`);
      } catch (e) {
        return mcpToolError("gitlab_reopen_issue", "issue-tools.ts", e);
      }
    }
  );
}
