/**
 * GitLab MR draft note tools — queue review comments and submit them as a batch.
 *
 * Workflow: create N draft notes (general or inline on diff), optionally update/delete,
 * then bulk-publish to "submit the review" (all become real notes atomically).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { numParam, mcpToolError, truncateText } from "../utils.js";
import { resolveProject } from "./shared.js";
import type { GitLabDraftNote, GitLabDraftNotePosition } from "../types.js";

const positionSchema = z.object({
  position_type: z.enum(["text", "image", "file"]).default("text"),
  base_sha: z.string().describe("Base SHA of the diff (from MR diff_refs.base_sha)"),
  head_sha: z.string().describe("Head SHA (from MR diff_refs.head_sha)"),
  start_sha: z.string().describe("Start SHA (from MR diff_refs.start_sha)"),
  old_path: z.string().optional().describe("File path before change"),
  new_path: z.string().optional().describe("File path after change"),
  old_line: numParam().optional().describe("Line number in the old file (for unchanged/removed lines)"),
  new_line: numParam().optional().describe("Line number in the new file (for unchanged/added lines)"),
});

function toClientPosition(
  p: z.infer<typeof positionSchema> | undefined
): GitLabDraftNotePosition | undefined {
  if (!p) return undefined;
  return {
    positionType: p.position_type,
    baseSha: p.base_sha,
    headSha: p.head_sha,
    startSha: p.start_sha,
    oldPath: p.old_path,
    newPath: p.new_path,
    oldLine: p.old_line,
    newLine: p.new_line,
  };
}

function formatDraftNote(d: GitLabDraftNote): string {
  const lines = [`Draft note ${d.id}:`];
  if (d.position) {
    const file = d.position.newPath || d.position.oldPath || "?";
    const line = d.position.newLine ?? d.position.oldLine ?? "?";
    lines.push(`  [${file}:${line}]`);
  }
  if (d.discussionId) lines.push(`  Reply to discussion: ${d.discussionId}`);
  if (d.resolveDiscussion) lines.push(`  Will resolve thread on publish`);
  lines.push(`  ${truncateText(d.note, 200)}`);
  return lines.join("\n");
}

export function registerDraftNoteTools(server: McpServer): void {
  server.registerTool(
    "gitlab_list_mr_draft_notes",
    {
      description:
        "List your pending (draft) review comments on an MR. Drafts are only visible to you until published.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
      },
    },
    async ({ project, mr_iid }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const drafts = await client.listMRDraftNotes(projectId, mr_iid);

        if (drafts.length === 0) {
          return { content: [{ type: "text", text: `MR !${mr_iid}: No draft notes pending.` }] };
        }

        const lines = [`MR !${mr_iid} draft notes (${drafts.length} pending):`];
        for (const d of drafts) {
          lines.push("------");
          lines.push(formatDraftNote(d));
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_mr_draft_notes", "draft-note-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_create_mr_draft_note",
    {
      description:
        "Queue a review comment on an MR without publishing. Use position to attach to a diff line " +
        "(get diff_refs from gitlab_get_merge_request). Use in_reply_to_discussion_id to draft a reply " +
        "in an existing thread. Call gitlab_publish_mr_draft_notes to submit all queued drafts.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        note: z.string().describe("Comment body (markdown)"),
        commit_id: z.string().optional().describe("Optional commit SHA to attach the note to"),
        in_reply_to_discussion_id: z
          .string()
          .optional()
          .describe("Existing discussion ID to reply to (mutually exclusive with position)"),
        resolve_discussion: z
          .boolean()
          .optional()
          .describe("If true and replying, resolve the thread when published"),
        position: positionSchema
          .optional()
          .describe("Inline diff position (omit for a general MR comment)"),
      },
    },
    async ({ project, mr_iid, note, commit_id, in_reply_to_discussion_id, resolve_discussion, position }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const draft = await client.createMRDraftNote(projectId, mr_iid, {
          note,
          commitId: commit_id,
          inReplyToDiscussionId: in_reply_to_discussion_id,
          resolveDiscussion: resolve_discussion,
          position: toClientPosition(position),
        });
        return {
          content: [
            {
              type: "text",
              text: `Queued draft on MR !${mr_iid}.\n${formatDraftNote(draft)}`,
            },
          ],
        };
      } catch (e) {
        return mcpToolError("gitlab_create_mr_draft_note", "draft-note-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_update_mr_draft_note",
    {
      description: "Edit a queued draft note before publishing.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        draft_note_id: numParam().describe("Draft note ID (from gitlab_list_mr_draft_notes)"),
        note: z.string().optional().describe("New comment body"),
        resolve_discussion: z.boolean().optional().describe("Whether to resolve the thread on publish"),
        position: positionSchema.optional().describe("Updated diff position"),
      },
    },
    async ({ project, mr_iid, draft_note_id, note, resolve_discussion, position }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const draft = await client.updateMRDraftNote(projectId, mr_iid, draft_note_id, {
          note,
          resolveDiscussion: resolve_discussion,
          position: toClientPosition(position),
        });
        return {
          content: [
            { type: "text", text: `Updated draft on MR !${mr_iid}.\n${formatDraftNote(draft)}` },
          ],
        };
      } catch (e) {
        return mcpToolError("gitlab_update_mr_draft_note", "draft-note-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_delete_mr_draft_note",
    {
      description: "Discard a queued draft note without publishing it.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        draft_note_id: numParam().describe("Draft note ID"),
      },
    },
    async ({ project, mr_iid, draft_note_id }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        await client.deleteMRDraftNote(projectId, mr_iid, draft_note_id);
        return {
          content: [{ type: "text", text: `Deleted draft note ${draft_note_id} on MR !${mr_iid}.` }],
        };
      } catch (e) {
        return mcpToolError("gitlab_delete_mr_draft_note", "draft-note-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_publish_mr_draft_note",
    {
      description:
        "Publish a single queued draft note (turns it into a real comment visible to everyone). " +
        "DESTRUCTIVE-ish / EXTERNALLY VISIBLE: this writes to a shared MR. " +
        "You MUST obtain explicit user confirmation before calling this tool — show the draft content " +
        "and target MR to the user and wait for an affirmative go-ahead. Do not call as a follow-up to " +
        "create/update without a fresh confirmation. The confirm parameter must be set to true.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        draft_note_id: numParam().describe("Draft note ID"),
        confirm: z
          .literal(true)
          .describe(
            "Must be true. Set only after the user has explicitly approved publishing this specific draft."
          ),
      },
    },
    async ({ project, mr_iid, draft_note_id, confirm }) => {
      try {
        if (confirm !== true) {
          return mcpToolError(
            "gitlab_publish_mr_draft_note",
            "draft-note-tools.ts",
            new Error(
              "Refusing to publish without explicit user confirmation (confirm=true required)."
            )
          );
        }
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        await client.publishMRDraftNote(projectId, mr_iid, draft_note_id);
        return {
          content: [{ type: "text", text: `Published draft note ${draft_note_id} on MR !${mr_iid}.` }],
        };
      } catch (e) {
        return mcpToolError("gitlab_publish_mr_draft_note", "draft-note-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_publish_mr_draft_notes",
    {
      description:
        "Submit the review: bulk-publish ALL queued draft notes on an MR at once (each becomes a " +
        "real comment visible to everyone). DESTRUCTIVE-ish / EXTERNALLY VISIBLE. " +
        "You MUST obtain explicit user confirmation before calling — list the pending drafts " +
        "(via gitlab_list_mr_draft_notes), show them to the user, and wait for an affirmative " +
        "go-ahead. Do not chain this after creating drafts in the same turn without a fresh " +
        "confirmation. Both confirm=true and the exact mr_iid must be provided.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        mr_iid: numParam().describe("MR IID"),
        confirm: z
          .literal(true)
          .describe(
            "Must be true. Set only after the user has explicitly approved publishing all queued drafts on this MR."
          ),
      },
    },
    async ({ project, mr_iid, confirm }) => {
      try {
        if (confirm !== true) {
          return mcpToolError(
            "gitlab_publish_mr_draft_notes",
            "draft-note-tools.ts",
            new Error(
              "Refusing to bulk-publish without explicit user confirmation (confirm=true required)."
            )
          );
        }
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        await client.bulkPublishMRDraftNotes(projectId, mr_iid);
        return {
          content: [{ type: "text", text: `Submitted review: published all draft notes on MR !${mr_iid}.` }],
        };
      } catch (e) {
        return mcpToolError("gitlab_publish_mr_draft_notes", "draft-note-tools.ts", e);
      }
    }
  );
}
