/**
 * GitLab status/info tool.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getGitLabClient } from "../api/gitlab.js";
import { mcpToolError } from "../utils.js";
import { textResult } from "./shared.js";

export function registerStatusTools(server: McpServer): void {
  server.registerTool(
    "gitlab_status",
    {
      description:
        "Show current GitLab configuration: detected project, branch, GitLab URL, and authentication status",
      inputSchema: {},
    },
    async () => {
      try {
        const client = getGitLabClient();
        const context = client.getGitContext();

        const lines = ["GitLab MCP Status:", ""];

        lines.push(`GitLab URL: ${client.getBaseUrl()}`);
        lines.push(`Authentication: Configured`);
        lines.push("");

        if (context) {
          lines.push("Git Context (auto-detected):");
          lines.push(`  Project: ${context.projectPath}`);
          lines.push(`  Branch: ${context.currentBranch || "(detached HEAD)"}`);
          lines.push(`  Git Root: ${context.gitRoot}`);
        } else {
          lines.push("Git Context: Not detected (not in a git repository with GitLab remote)");
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_status", "status-tools.ts", e);
      }
    }
  );
}
