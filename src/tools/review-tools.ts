/**
 * MR review orchestration tools.
 * Designed for multi-call orchestration where Claude Code delegates
 * each chunk to a subagent for parallel review.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { numParam, mcpToolError } from "../utils.js";
import { resolveProject } from "./shared.js";
import { groupFilesIntoChunks, formatManifest } from "./review/grouping.js";
import type { ReviewManifest } from "./review/grouping.js";

export function registerReviewTools(server: McpServer): void {
  server.registerTool(
    "gitlab_prepare_mr_review",
    {
      description:
        "Prepare an MR for chunked review. Returns a manifest of chunks grouped by directory. " +
        "Review each chunk via gitlab_get_review_chunk.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
      },
    },
    async ({ project, mr_iid }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);

        // Fetch MR details and changes
        const mr = await client.getMergeRequest(projectId, mr_iid);
        const changes = await client.getMergeRequestChanges(projectId, mr_iid);

        // Group files into review chunks
        const chunks = groupFilesIntoChunks(changes.changes);

        const manifest: ReviewManifest = {
          mrIid: mr.iid,
          title: mr.title,
          sourceBranch: mr.sourceBranch,
          targetBranch: mr.targetBranch,
          author: mr.author.username,
          totalFiles: changes.changes.length,
          totalChunks: chunks.length,
          chunks,
          overflowWarning: changes.overflow
            ? "Changes exceed GitLab API limit. Some files may be missing from the review."
            : undefined,
        };

        return {
          content: [{ type: "text", text: formatManifest(manifest) }],
        };
      } catch (e) {
        return mcpToolError("gitlab_prepare_mr_review", "review-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_review_chunk",
    {
      description:
        "Get full diffs for a review chunk from gitlab_prepare_mr_review. " +
        "Optionally includes discussions and commits.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        chunk_id: z.string().describe("Chunk ID from gitlab_prepare_mr_review (e.g. 'src-api', 'config')"),
        detail_level: z
          .enum(["diff", "diff_discussions", "full"])
          .optional()
          .default("diff")
          .describe("diff = diffs only, diff_discussions = diffs + discussions, full = diffs + discussions + commits"),
      },
    },
    async ({ project, mr_iid, chunk_id, detail_level }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);

        // Fetch MR changes to find files for this chunk
        const changes = await client.getMergeRequestChanges(projectId, mr_iid);
        const chunks = groupFilesIntoChunks(changes.changes);

        const chunk = chunks.find((c) => c.chunkId === chunk_id);
        if (!chunk) {
          const available = chunks.map((c) => c.chunkId).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `Error: Chunk '${chunk_id}' not found. Available chunks: ${available}`,
              },
            ],
          };
        }

        // Get the full diffs for files in this chunk (untruncated)
        const chunkFiles = new Set(chunk.files);
        const fileChanges = changes.changes.filter(
          (c) => chunkFiles.has(c.newPath) || chunkFiles.has(c.oldPath)
        );

        const lines = [
          `## Review Chunk: ${chunk.groupName} - MR !${mr_iid}`,
          `Changes: +${chunk.totalAdditions} -${chunk.totalDeletions}`,
          "",
        ];

        // Add full untruncated diffs
        for (let i = 0; i < fileChanges.length; i++) {
          const change = fileChanges[i];
          const status = change.newFile
            ? "Added"
            : change.deletedFile
              ? "Deleted"
              : change.renamedFile
                ? "Renamed"
                : "Modified";

          lines.push(
            `### File ${i + 1}/${fileChanges.length}: ${change.newPath} (${status})`
          );
          if (change.renamedFile && change.oldPath !== change.newPath) {
            lines.push(`Renamed from: ${change.oldPath}`);
          }
          lines.push("```diff");
          lines.push(change.diff); // Full untruncated diff
          lines.push("```");
          lines.push("");
        }

        // Optionally add discussions
        if (detail_level === "diff_discussions" || detail_level === "full") {
          // Fetch all discussions
          const allDiscussions: Array<{
            id: string;
            notes: Array<{
              body: string;
              author: { username: string };
              system: boolean;
              resolvable?: boolean;
              resolved?: boolean;
              position?: {
                newPath?: string;
                oldPath?: string;
                newLine?: number;
                oldLine?: number;
              };
            }>;
          }> = [];

          let page = 1;
          while (true) {
            const result = await client.listMRDiscussions(projectId, mr_iid, {
              page,
              perPage: 100,
            });
            allDiscussions.push(...result.data);
            if (!result.nextPage) break;
            page = result.nextPage;
          }

          // Filter to discussions on files in this chunk
          const chunkDiscussions = allDiscussions.filter((d) =>
            d.notes.some(
              (n) =>
                !n.system &&
                n.position &&
                (chunkFiles.has(n.position.newPath || "") ||
                  chunkFiles.has(n.position.oldPath || ""))
            )
          );

          if (chunkDiscussions.length > 0) {
            lines.push("---");
            lines.push(
              `## Discussions (${chunkDiscussions.length} threads on these files)`
            );
            lines.push("");

            for (const discussion of chunkDiscussions) {
              const firstNote = discussion.notes.find((n) => !n.system);
              if (!firstNote) continue;

              const file =
                firstNote.position?.newPath ||
                firstNote.position?.oldPath ||
                "unknown";
              const line =
                firstNote.position?.newLine ||
                firstNote.position?.oldLine ||
                "?";
              const resolved = discussion.notes
                .filter((n) => n.resolvable)
                .every((n) => n.resolved);

              lines.push(
                `### ${file}:${line} ${resolved ? "[RESOLVED]" : "[UNRESOLVED]"}`
              );
              for (const note of discussion.notes) {
                if (note.system) continue;
                lines.push(`- @${note.author.username}: ${note.body}`);
              }
              lines.push("");
            }
          } else {
            lines.push("---");
            lines.push("No discussions on files in this chunk.");
            lines.push("");
          }
        }

        // Optionally add commits
        if (detail_level === "full") {
          // Fetch MR commits
          const commitsResult = await client.getMergeRequestCommits(
            projectId,
            mr_iid,
            { perPage: 100 }
          );

          // We can't easily filter commits by file without fetching each commit's diff,
          // so we include all commits as context
          if (commitsResult.data.length > 0) {
            lines.push("---");
            lines.push(
              `## Commits in this MR (${commitsResult.data.length} total)`
            );
            lines.push("");

            for (const commit of commitsResult.data) {
              lines.push(`- ${commit.shortId}: ${commit.title}`);
              if (
                commit.message &&
                commit.message !== commit.title &&
                commit.message.trim() !== commit.title.trim()
              ) {
                // Include full commit message if it differs from title
                const body = commit.message
                  .replace(commit.title, "")
                  .trim();
                if (body) {
                  lines.push(`  ${body.split("\n").join("\n  ")}`);
                }
              }
            }
            lines.push("");
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_get_review_chunk", "review-tools.ts", e);
      }
    }
  );
}
