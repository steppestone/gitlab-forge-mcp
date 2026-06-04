/**
 * GitLab project tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { formatDate, numParam, mcpToolError } from "../utils.js";
import { resolveProject } from "./shared.js";

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "gitlab_get_project",
    {
      description:
        "Get information about a GitLab project.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project path/ID (default: current repo)"),
      },
    },
    async ({ project }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const proj = await client.getProject(projectId);

        const text = [
          `Project: ${proj.nameWithNamespace}`,
          `ID: ${proj.id}`,
          `Path: ${proj.pathWithNamespace}`,
          `Description: ${proj.description || "(none)"}`,
          `Default Branch: ${proj.defaultBranch}`,
          `Visibility: ${proj.visibility}`,
          `URL: ${proj.webUrl}`,
          `SSH: ${proj.sshUrlToRepo}`,
          `HTTP: ${proj.httpUrlToRepo}`,
          `Created: ${formatDate(proj.createdAt)}`,
          `Last Activity: ${formatDate(proj.lastActivityAt)}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (e) {
        return mcpToolError("gitlab_get_project", "project-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_list_projects",
    {
      description: "List GitLab projects accessible to the authenticated user",
      inputSchema: {
        search: z.string().optional().describe("Search query for project name"),
        owned: z.boolean().optional().describe("Only list owned projects"),
        membership: z
          .boolean()
          .optional()
          .describe("Only list projects where user is a member"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(20).describe("Per page"),
      },
    },
    async ({ search, owned, membership, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const result = await client.listProjects({
          search,
          owned,
          membership,
          page,
          perPage: per_page,
        });

        const lines = [
          `Projects (page ${result.page}/${result.totalPages}, total: ${result.total}):`,
          "",
        ];

        for (const proj of result.data) {
          lines.push(`${proj.pathWithNamespace} (ID: ${proj.id})`);
          if (proj.description) {
            lines.push(`  ${proj.description.slice(0, 100)}`);
          }
          lines.push("");
        }

        if (result.nextPage) {
          lines.push(`Use page=${result.nextPage} to see more results.`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_projects", "project-tools.ts", e);
      }
    }
  );
}
