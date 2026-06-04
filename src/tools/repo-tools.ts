/**
 * GitLab repository tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { formatDate, truncateText, extractLines, numParam, mcpToolError } from "../utils.js";
import { resolveProject, formatCommit } from "./shared.js";

export function registerRepoTools(server: McpServer): void {
  server.registerTool(
    "gitlab_list_branches",
    {
      description: "List branches in a GitLab project.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        search: z.string().optional().describe("Search query for branch name"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(20).describe("Per page"),
      },
    },
    async ({ project, search, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listBranches(projectId, {
          search,
          page,
          perPage: per_page,
        });

        const lines = [
          `Branches in ${projectId} (page ${result.page}/${result.totalPages}):`,
          "",
        ];

        for (const branch of result.data) {
          const flags = [];
          if (branch.default) flags.push("default");
          if (branch.protected) flags.push("protected");
          if (branch.merged) flags.push("merged");

          lines.push(
            `${branch.name}${flags.length ? ` [${flags.join(", ")}]` : ""}`
          );
          lines.push(`  Latest: ${branch.commit.shortId} - ${branch.commit.title}`);
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_branches", "repo-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_list_commits",
    {
      description: "List commits in a GitLab project.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        ref: z.string().optional().describe("Branch or tag name"),
        path: z.string().optional().describe("Filter by file path"),
        since: z.string().optional().describe("Only commits after this date (ISO 8601)"),
        until: z.string().optional().describe("Only commits before this date (ISO 8601)"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(20).describe("Per page"),
      },
    },
    async ({ project, ref, path, since, until, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listCommits(projectId, {
          refName: ref,
          path,
          since,
          until,
          page,
          perPage: per_page,
        });

        const lines = [
          `Commits in ${projectId}${ref ? ` (${ref})` : ""} (page ${result.page}/${result.totalPages}):`,
          "",
        ];

        for (const commit of result.data) {
          lines.push(formatCommit(commit));
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_commits", "repo-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_commit",
    {
      description: "Get details of a specific commit including its diff.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        sha: z.string().describe("Commit SHA"),
        include_diff: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include the commit diff"),
      },
    },
    async ({ project, sha, include_diff }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const commit = await client.getCommit(projectId, sha);

        const lines = [
          `Commit: ${commit.id}`,
          `Title: ${commit.title}`,
          `Author: ${commit.authorName} <${commit.authorEmail}>`,
          `Date: ${formatDate(commit.authoredDate)}`,
          "",
          "Message:",
          commit.message,
          "",
          `URL: ${commit.webUrl}`,
        ];

        if (include_diff) {
          const diff = await client.getCommitDiff(projectId, sha);
          lines.push("");
          lines.push("Changes:");

          for (const file of diff) {
            const status = file.newFile
              ? "A"
              : file.deletedFile
                ? "D"
                : file.renamedFile
                  ? "R"
                  : "M";
            lines.push(`\n[${status}] ${file.newPath}`);
            if (file.renamedFile && file.oldPath !== file.newPath) {
              lines.push(`    (renamed from ${file.oldPath})`);
            }
            lines.push(truncateText(file.diff, 2000));
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_get_commit", "repo-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_file",
    {
      description: "Get contents of a file from the repository.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        path: z.string().describe("File path in the repository"),
        ref: z.string().optional().default("HEAD").describe("Branch, tag, or commit SHA"),
        start_line: numParam().optional().describe("Start line (1-indexed). Use with end_line or max_lines to fetch a range."),
        end_line: numParam().optional().describe("End line (1-indexed, inclusive). Use with start_line to fetch a specific range."),
        max_lines: numParam().optional().default(200).describe("Maximum lines to return (default 200). Set to 0 for unlimited."),
      },
    },
    async ({ project, path, ref, start_line, end_line, max_lines }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const rawContent = await client.getFileRaw(projectId, path, ref);

        const effectiveMaxLines = max_lines === 0 ? undefined : max_lines;
        const { content, totalLines, returnedRange } = extractLines(rawContent, {
          startLine: start_line,
          endLine: end_line,
          maxLines: effectiveMaxLines,
        });

        const rangeInfo = effectiveMaxLines || start_line || end_line
          ? ` (${returnedRange} of ${totalLines})`
          : ` (${totalLines} lines)`;
        const header = `File: ${path} (ref: ${ref})${rangeInfo}`;

        return {
          content: [
            {
              type: "text",
              text: `${header}\n\n${truncateText(content, 50000)}`,
            },
          ],
        };
      } catch (e) {
        return mcpToolError("gitlab_get_file", "repo-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_list_tree",
    {
      description: "List files and directories in a repository path.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        path: z.string().optional().describe("Path in repository (default: root)"),
        ref: z.string().optional().describe("Branch, tag, or commit SHA"),
        recursive: z.boolean().optional().describe("List recursively"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(50).describe("Per page"),
      },
    },
    async ({ project, path, ref, recursive, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listTree(projectId, {
          path,
          ref,
          recursive,
          page,
          perPage: per_page,
        });

        const lines = [
          `Tree: ${projectId}${path ? `/${path}` : ""}${ref ? ` (${ref})` : ""}`,
          "",
        ];

        for (const item of result.data) {
          const icon = item.type === "tree" ? "/" : "";
          lines.push(`${item.path}${icon}`);
        }

        if (result.nextPage) {
          lines.push("");
          lines.push(`Use page=${result.nextPage} to see more results.`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_tree", "repo-tools.ts", e);
      }
    }
  );
}
