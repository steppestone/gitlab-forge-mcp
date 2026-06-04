/**
 * Tool registration module.
 * Registers all MCP tools with the server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatusTools } from "./status-tools.js";
import { registerProjectTools } from "./project-tools.js";
import { registerRepoTools } from "./repo-tools.js";
import { registerIssueTools } from "./issue-tools.js";
import { registerMRTools } from "./mr-tools.js";
import { registerDiscussionTools } from "./discussion-tools.js";
import { registerDraftNoteTools } from "./draft-note-tools.js";
import { registerCompareTools } from "./compare-tools.js";
import { registerPipelineTools } from "./pipeline-tools.js";
import { registerReviewTools } from "./review-tools.js";
import { registerLabelTools } from "./label-tools.js";

export function registerAllTools(server: McpServer): void {
  registerStatusTools(server);
  registerProjectTools(server);
  registerRepoTools(server);
  registerIssueTools(server);
  registerMRTools(server);
  registerDiscussionTools(server);
  registerDraftNoteTools(server);
  registerCompareTools(server);
  registerPipelineTools(server);
  registerReviewTools(server);
  registerLabelTools(server);
}
