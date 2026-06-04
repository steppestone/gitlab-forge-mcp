/**
 * GitLab compare/diff tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { mcpToolError } from "../utils.js";
import { resolveProject } from "./shared.js";

export function registerCompareTools(server: McpServer): void {
  server.registerTool(
    "gitlab_compare",
    {
      description:
        "Compare two branches, tags, or commits to see the differences.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        from: z.string().describe("Source branch/tag/commit SHA"),
        to: z.string().describe("Target branch/tag/commit SHA"),
      },
    },
    async ({ project, from, to }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.compare(projectId, from, to);

        const lines = [
          `Comparing ${from}...${to}`,
          "",
          `Commits: ${result.commits.length}`,
          `Files changed: ${result.diffs.length}`,
          "",
        ];

        if (result.compareSameRef) {
          lines.push("Note: Both refs point to the same commit.");
        }

        if (result.compareTimeout) {
          lines.push("WARNING: Compare timed out. Results may be incomplete.");
        }

        lines.push("Commits:");
        for (const commit of result.commits.slice(0, 10)) {
          lines.push(`  ${commit.shortId}: ${commit.title}`);
        }
        if (result.commits.length > 10) {
          lines.push(`  ... and ${result.commits.length - 10} more commits`);
        }

        lines.push("");
        lines.push("Changed files:");
        for (const diff of result.diffs) {
          const status = diff.newFile
            ? "A"
            : diff.deletedFile
              ? "D"
              : diff.renamedFile
                ? "R"
                : "M";
          lines.push(`  [${status}] ${diff.newPath}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_compare", "compare-tools.ts", e);
      }
    }
  );
}
