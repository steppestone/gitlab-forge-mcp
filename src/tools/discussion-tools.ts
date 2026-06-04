/**
 * GitLab discussion and notes tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { truncateText, numParam, mcpToolError } from "../utils.js";
import { resolveProject, isDiscussionResolved, formatDiscussion } from "./shared.js";

export function registerDiscussionTools(server: McpServer): void {
  server.registerTool(
    "gitlab_list_mr_discussions",
    {
      description: "List MR discussion threads. Excludes resolved by default.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        include_resolved: z.boolean().optional().default(false).describe("Include resolved discussions"),
        include_system: z.boolean().optional().default(false).describe("Include system notes"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(50).describe("Per page"),
      },
    },
    async ({ project, mr_iid, include_resolved, include_system, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);

        const result = await client.listMRDiscussions(projectId, mr_iid, {
          page,
          perPage: per_page,
        });

        let discussions = result.data;
        if (!include_resolved) {
          discussions = discussions.filter((d) => !isDiscussionResolved(d));
        }

        if (discussions.length === 0) {
          const msg = include_resolved
            ? "No discussions found."
            : "No unresolved discussions. Use include_resolved=true to see all.";
          return { content: [{ type: "text", text: `MR !${mr_iid}: ${msg}` }] };
        }

        const lines = [`MR !${mr_iid} discussions (${discussions.length} unresolved):`];

        for (const discussion of discussions) {
          lines.push("------");
          lines.push(`Discussion ID: ${discussion.id}`);

          const firstNote = discussion.notes[0] as {
            position?: {
              newPath?: string;
              oldPath?: string;
              newLine?: number;
              oldLine?: number;
            };
          } & typeof discussion.notes[0];

          if (firstNote?.position) {
            const pos = firstNote.position;
            const file = pos.newPath || pos.oldPath || "?";
            const line = pos.newLine || pos.oldLine || "?";
            lines.push(`[${file}:${line}]`);
          }

          lines.push(formatDiscussion(discussion, include_system));
        }

        const output = lines.join("\n");

        if (result.nextPage) {
          lines.push("------");
          lines.push(`page=${result.nextPage} for more`);
        }

        return { content: [{ type: "text", text: output }] };
      } catch (e) {
        return mcpToolError("gitlab_list_mr_discussions", "discussion-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_list_mr_notes",
    {
      description:
        "List notes (comments) on a merge request in flat format. By default excludes resolved and system notes.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        include_resolved: z.boolean().optional().default(false).describe("Include resolved notes"),
        include_system: z.boolean().optional().default(false).describe("Include system notes"),
        sort: z.enum(["asc", "desc"]).optional().default("asc").describe("Sort order"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(100).describe("Per page"),
      },
    },
    async ({ project, mr_iid, include_resolved, include_system, sort, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listMRNotes(projectId, mr_iid, {
          sort,
          page,
          perPage: per_page,
        });

        let notes = result.data;
        if (!include_system) {
          notes = notes.filter((n) => !n.system);
        }
        if (!include_resolved) {
          notes = notes.filter((n) => !n.resolved);
        }

        if (notes.length === 0) {
          return { content: [{ type: "text", text: `MR !${mr_iid}: No unresolved comments.` }] };
        }

        const lines = [`MR !${mr_iid} notes (${notes.length}):`];

        for (const note of notes) {
          lines.push("------");
          lines.push(`Note ID: ${note.id}${note.resolvable ? (note.resolved ? " [resolved]" : " [unresolved]") : ""}`);
          if (note.system) {
            lines.push(`[sys] ${note.body}`);
          } else {
            lines.push(`@${note.author.username}: ${note.body}`);
          }
        }

        if (result.nextPage) {
          lines.push("------");
          lines.push(`page=${result.nextPage} for more`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_mr_notes", "discussion-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_resolve_mr_discussion",
    {
      description:
        "Resolve or unresolve a discussion thread on a merge request.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        discussion_id: z.string().describe("Discussion ID (from gitlab_list_mr_discussions)"),
        resolved: z.boolean().optional().default(true).describe("Set to true to resolve, false to unresolve"),
      },
    },
    async ({ project, mr_iid, discussion_id, resolved }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const discussion = await client.resolveMRDiscussion(projectId, mr_iid, discussion_id, resolved);

        const action = resolved ? "Resolved" : "Unresolved";
        const firstNote = discussion.notes[0];
        const snippet = firstNote
          ? truncateText(firstNote.body, 100)
          : "(empty)";

        return {
          content: [
            {
              type: "text",
              text: `${action} discussion on MR !${mr_iid}\nThread: ${snippet}`,
            },
          ],
        };
      } catch (e) {
        return mcpToolError("gitlab_resolve_mr_discussion", "discussion-tools.ts", e);
      }
    }
  );
}
