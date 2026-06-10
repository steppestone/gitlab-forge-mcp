/**
 * MR review orchestration tools.
 * Designed for multi-call orchestration where Claude Code delegates
 * each chunk to a subagent for parallel review.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { numParam, mcpToolError } from "../utils.js";
import {
  resolveProject,
  textResult,
  formatPositionRef,
  fileStatusLabel,
  isDiscussionResolved,
  projectParam,
} from "./shared.js";
import { groupFilesIntoChunks, formatManifest } from "./review/grouping.js";
import type { ReviewManifest } from "./review/grouping.js";

/** Discussion shape returned by listMRDiscussions, as consumed by the chunk renderer. */
type ChunkDiscussion = {
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
};

/** File-change shape returned by getMergeRequestChanges, as consumed by the chunk renderer. */
type ChunkFileChange = {
  newPath: string;
  oldPath: string;
  diff: string;
  newFile?: boolean;
  deletedFile?: boolean;
  renamedFile?: boolean;
};

/** Commit shape returned by getMergeRequestCommits, as consumed by the chunk renderer. */
type ChunkCommit = {
  shortId: string;
  title: string;
  message?: string;
};

/** Render the untruncated diffs for the files in a chunk. */
function renderChunkFiles(fileChanges: ChunkFileChange[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < fileChanges.length; i++) {
    const change = fileChanges[i];
    const status = fileStatusLabel(change);

    lines.push(`### File ${i + 1}/${fileChanges.length}: ${change.newPath} (${status})`);
    if (change.renamedFile && change.oldPath !== change.newPath) {
      lines.push(`Renamed from: ${change.oldPath}`);
    }
    lines.push("```diff");
    lines.push(change.diff); // Full untruncated diff
    lines.push("```");
    lines.push("");
  }
  return lines;
}

/** Render the discussions that touch files in this chunk. */
function renderChunkDiscussions(
  allDiscussions: ChunkDiscussion[],
  chunkFiles: Set<string>
): string[] {
  const lines: string[] = [];

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
    lines.push(`## Discussions (${chunkDiscussions.length} threads on these files)`);
    lines.push("");

    for (const discussion of chunkDiscussions) {
      const firstNote = discussion.notes.find((n) => !n.system);
      if (!firstNote) continue;

      const ref = formatPositionRef(firstNote.position);
      const resolved = isDiscussionResolved(discussion);

      lines.push(`### ${ref} ${resolved ? "[RESOLVED]" : "[UNRESOLVED]"}`);
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

  return lines;
}

/** Render the MR commit list as review context. */
function renderChunkCommits(commits: ChunkCommit[]): string[] {
  const lines: string[] = [];
  if (commits.length > 0) {
    lines.push("---");
    lines.push(`## Commits in this MR (${commits.length} total)`);
    lines.push("");

    for (const commit of commits) {
      lines.push(`- ${commit.shortId}: ${commit.title}`);
      if (
        commit.message &&
        commit.message !== commit.title &&
        commit.message.trim() !== commit.title.trim()
      ) {
        // Include full commit message if it differs from title
        const body = commit.message.replace(commit.title, "").trim();
        if (body) {
          lines.push(`  ${body.split("\n").join("\n  ")}`);
        }
      }
    }
    lines.push("");
  }
  return lines;
}

export function registerReviewTools(server: McpServer): void {
  server.registerTool(
    "gitlab_prepare_mr_review",
    {
      description:
        "Prepare an MR for chunked review. Returns a manifest of chunks grouped by directory. " +
        "Review each chunk via gitlab_get_review_chunk.",
      inputSchema: {
        project: projectParam(),
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

        return textResult(formatManifest(manifest));
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
        project: projectParam(),
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

        // Fetch MR changes to find files for this chunk.
        // NOTE: this recomputes groupFilesIntoChunks on every chunk fetch
        // (same as gitlab_prepare_mr_review); caching is out of scope here.
        const changes = await client.getMergeRequestChanges(projectId, mr_iid);
        const chunks = groupFilesIntoChunks(changes.changes);

        const chunk = chunks.find((c) => c.chunkId === chunk_id);
        if (!chunk) {
          const available = chunks.map((c) => c.chunkId).join(", ");
          return textResult(
            `Error: Chunk '${chunk_id}' not found. Available chunks: ${available}`
          );
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
        lines.push(...renderChunkFiles(fileChanges));

        // Optionally add discussions
        if (detail_level === "diff_discussions" || detail_level === "full") {
          // Fetch all discussions
          const allDiscussions: ChunkDiscussion[] = [];

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

          lines.push(...renderChunkDiscussions(allDiscussions, chunkFiles));
        }

        // Optionally add commits
        if (detail_level === "full") {
          // Fetch MR commits.
          // We can't easily filter commits by file without fetching each commit's diff,
          // so we include all commits as context.
          const commitsResult = await client.getMergeRequestCommits(
            projectId,
            mr_iid,
            { perPage: 100 }
          );
          lines.push(...renderChunkCommits(commitsResult.data));
        }

        return textResult(lines);
      } catch (e) {
        return mcpToolError("gitlab_get_review_chunk", "review-tools.ts", e);
      }
    }
  );
}
