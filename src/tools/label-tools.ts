/**
 * GitLab label tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { numParam, mcpToolError } from "../utils.js";
import { resolveProject } from "./shared.js";

export function registerLabelTools(server: McpServer): void {
  server.registerTool(
    "gitlab_search_labels",
    {
      description: "Search for labels in a project. Returns all labels when no search term is provided.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        search: z.string().optional().describe("Search term to filter labels by name"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(50).describe("Per page"),
      },
    },
    async ({ project, search, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.searchLabels(projectId, {
          search,
          page,
          perPage: per_page,
        });

        const lines = [
          `Labels in ${projectId}${search ? ` matching "${search}"` : ""} (${result.total} total):`,
          "",
        ];

        for (const label of result.data) {
          lines.push(`${label.name}`);
          if (label.description) lines.push(`  ${label.description}`);
          lines.push(`  Color: ${label.color}  Open issues: ${label.openIssuesCount}  Open MRs: ${label.openMergeRequestsCount}`);
          if (label.priority !== null) lines.push(`  Priority: ${label.priority}`);
          lines.push("");
        }

        if (result.nextPage) {
          lines.push(`Use page=${result.nextPage} to see more.`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_search_labels", "label-tools.ts", e);
      }
    }
  );
}
