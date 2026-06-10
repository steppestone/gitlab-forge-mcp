/**
 * GitLab access token tools.
 *
 * Generates project access tokens and personal access tokens.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { formatDate, numParam, mcpToolError } from "../utils.js";
import { resolveProject, textResult, projectParam } from "./shared.js";
import type { GitLabAccessToken } from "../types.js";

/** Map a numeric project access level to its GitLab role name. */
const ACCESS_LEVEL_NAMES: Record<number, string> = {
  10: "Guest",
  15: "Planner",
  20: "Reporter",
  30: "Developer",
  40: "Maintainer",
  50: "Owner",
};

/** Render a created access token (including its one-time secret) for display. */
function formatToken(token: GitLabAccessToken): string {
  const lines = [
    `Name: ${token.name}`,
    `ID: ${token.id}`,
    `Scopes: ${token.scopes.join(", ")}`,
  ];
  if (token.accessLevel !== undefined) {
    const role = ACCESS_LEVEL_NAMES[token.accessLevel] ?? "Unknown";
    lines.push(`Access Level: ${token.accessLevel} (${role})`);
  }
  lines.push(`Active: ${token.active}`);
  lines.push(`Expires: ${token.expiresAt ? formatDate(token.expiresAt) : "(never)"}`);
  lines.push(`Created: ${formatDate(token.createdAt)}`);
  lines.push("");
  lines.push(`Token: ${token.token ?? "(not returned)"}`);
  lines.push("");
  lines.push("⚠️  Copy this token now — GitLab will not show it again.");
  return lines.join("\n");
}

export function registerTokenTools(server: McpServer): void {
  server.registerTool(
    "gitlab_create_project_access_token",
    {
      description:
        "Create a project access token. Requires Owner (or Maintainer) on the project. " +
        "The token secret is returned once and cannot be retrieved later.",
      inputSchema: {
        project: projectParam(),
        name: z.string().describe("Name for the token"),
        scopes: z
          .array(z.string())
          .min(1)
          .default(["api"])
          .describe(
            "Token scopes, e.g. api, read_api, read_repository, write_repository, read_registry, write_registry, create_runner, ai_features"
          ),
        access_level: numParam()
          .optional()
          .default(30)
          .describe(
            "Role for the token: 10=Guest, 15=Planner, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner (default: 30=Developer)"
          ),
        expires_at: z
          .string()
          .optional()
          .describe(
            "Expiry date YYYY-MM-DD. If omitted, GitLab applies the maximum allowed lifetime (typically 1 year)."
          ),
      },
    },
    async ({ project, name, scopes, access_level, expires_at }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const token = await client.createProjectAccessToken(projectId, {
          name,
          scopes,
          accessLevel: access_level,
          expiresAt: expires_at,
        });

        const text = [
          `Project access token created for ${projectId}:`,
          "",
          formatToken(token),
        ].join("\n");

        return textResult(text);
      } catch (e) {
        return mcpToolError(
          "gitlab_create_project_access_token",
          "token-tools.ts",
          e
        );
      }
    }
  );

  server.registerTool(
    "gitlab_create_personal_access_token",
    {
      description:
        "Create a personal access token for a user. Uses the admin endpoint, so it " +
        "requires administrator privileges on the GitLab instance. Defaults to the " +
        "currently authenticated user. The token secret is returned once.",
      inputSchema: {
        user_id: numParam()
          .optional()
          .describe(
            "Numeric user ID to create the token for (default: the authenticated user)"
          ),
        name: z.string().describe("Name for the token"),
        scopes: z
          .array(z.string())
          .min(1)
          .default(["api"])
          .describe(
            "Token scopes, e.g. api, read_api, read_user, read_repository, write_repository, read_registry, write_registry, sudo, admin_mode"
          ),
        expires_at: z
          .string()
          .optional()
          .describe(
            "Expiry date YYYY-MM-DD. If omitted, GitLab applies the maximum allowed lifetime."
          ),
        description: z
          .string()
          .optional()
          .describe("Optional description for the token"),
      },
    },
    async ({ user_id, name, scopes, expires_at, description }) => {
      try {
        const client = getGitLabClient();

        let userId = user_id;
        if (userId === undefined) {
          const me = await client.getCurrentUser();
          userId = me.id;
        }

        const token = await client.createPersonalAccessToken(userId, {
          name,
          scopes,
          expiresAt: expires_at,
          description,
        });

        const text = [
          `Personal access token created for user ${userId}:`,
          "",
          formatToken(token),
        ].join("\n");

        return textResult(text);
      } catch (e) {
        return mcpToolError(
          "gitlab_create_personal_access_token",
          "token-tools.ts",
          e
        );
      }
    }
  );
}
