/**
 * GitLab pipeline and job tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getGitLabClient } from "../api/gitlab.js";
import { formatDate, numParam, mcpToolError } from "../utils.js";
import { resolveProject } from "./shared.js";

export function registerPipelineTools(server: McpServer): void {
  server.registerTool(
    "gitlab_list_pipelines",
    {
      description: "List pipelines in a project.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        status: z.enum(["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"]).optional().describe("Filter by pipeline status"),
        ref: z.string().optional().describe("Filter by branch or tag name"),
        scope: z.enum(["running", "pending", "finished", "branches", "tags"]).optional().describe("Filter by scope"),
        source: z.string().optional().describe("Filter by source (push, web, trigger, schedule, api, pipeline, merge_request_event)"),
        order_by: z.enum(["id", "status", "ref", "updated_at", "user_id"]).optional().default("id").describe("Order by field"),
        sort: z.enum(["asc", "desc"]).optional().default("desc").describe("Sort order"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(20).describe("Per page"),
      },
    },
    async ({ project, status, ref, scope, source, order_by, sort, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listPipelines(projectId, {
          status,
          ref,
          scope,
          source,
          orderBy: order_by,
          sort,
          page,
          perPage: per_page,
        });

        const lines = [`Pipelines (page ${result.page}/${result.totalPages}, total: ${result.total}):`, ""];

        for (const pipeline of result.data) {
          const duration = pipeline.duration ? `${Math.round(pipeline.duration / 60)}m` : "-";
          lines.push(`#${pipeline.id} [${pipeline.status.toUpperCase()}] ${pipeline.ref}`);
          lines.push(`  SHA: ${pipeline.sha.slice(0, 8)} | Duration: ${duration}`);
          lines.push(`  Source: ${pipeline.source} | Created: ${formatDate(pipeline.createdAt)}`);
          lines.push(`  URL: ${pipeline.webUrl}`);
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_pipelines", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_pipeline",
    {
      description: "Get details of a specific pipeline.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        pipeline_id: numParam().describe("Pipeline ID"),
      },
    },
    async ({ project, pipeline_id }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const pipeline = await client.getPipeline(projectId, pipeline_id);

        const duration = pipeline.duration ? `${Math.round(pipeline.duration / 60)}m ${pipeline.duration % 60}s` : "N/A";
        const queuedDuration = pipeline.queuedDuration ? `${pipeline.queuedDuration}s` : "N/A";

        const lines = [
          `Pipeline #${pipeline.id}`,
          ``,
          `Status: ${pipeline.status.toUpperCase()}`,
          `Ref: ${pipeline.ref}${pipeline.tag ? " (tag)" : ""}`,
          `SHA: ${pipeline.sha}`,
          `Source: ${pipeline.source}`,
          ``,
          `Created: ${formatDate(pipeline.createdAt)}`,
          `Started: ${pipeline.startedAt ? formatDate(pipeline.startedAt) : "N/A"}`,
          `Finished: ${pipeline.finishedAt ? formatDate(pipeline.finishedAt) : "N/A"}`,
          `Duration: ${duration}`,
          `Queued: ${queuedDuration}`,
          ``,
          `User: ${pipeline.user?.name || "N/A"} (@${pipeline.user?.username || "N/A"})`,
          `Coverage: ${pipeline.coverage || "N/A"}`,
          ``,
          `URL: ${pipeline.webUrl}`,
        ];

        if (pipeline.yamlErrors) {
          lines.push("", `YAML Errors: ${pipeline.yamlErrors}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_get_pipeline", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_list_pipeline_jobs",
    {
      description: "List jobs in a pipeline.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        pipeline_id: numParam().describe("Pipeline ID"),
        scope: z.enum(["created", "pending", "running", "failed", "success", "canceled", "skipped", "manual"]).optional().describe("Filter by job status"),
        include_retried: z.boolean().optional().default(false).describe("Include retried jobs"),
        page: numParam().optional().default(1).describe("Page"),
        per_page: numParam().optional().default(50).describe("Per page"),
      },
    },
    async ({ project, pipeline_id, scope, include_retried, page, per_page }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const result = await client.listPipelineJobs(projectId, pipeline_id, {
          scope,
          includeRetried: include_retried,
          page,
          perPage: per_page,
        });

        const lines = [`Jobs in Pipeline #${pipeline_id} (${result.total} total):`, ""];

        const jobsByStage = new Map<string, typeof result.data>();
        for (const job of result.data) {
          const stage = job.stage;
          if (!jobsByStage.has(stage)) {
            jobsByStage.set(stage, []);
          }
          jobsByStage.get(stage)!.push(job);
        }

        for (const [stage, jobs] of jobsByStage) {
          lines.push(`Stage: ${stage}`);
          for (const job of jobs) {
            const duration = job.duration ? `${Math.round(job.duration)}s` : "-";
            const status = job.status.toUpperCase();
            const allowFailure = job.allowFailure ? " (allowed to fail)" : "";
            lines.push(`  [${status}] ${job.name} (#${job.id}) - ${duration}${allowFailure}`);
            if (job.failureReason) {
              lines.push(`    Failure: ${job.failureReason}`);
            }
          }
          lines.push("");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_list_pipeline_jobs", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_job",
    {
      description: "Get details of a specific job.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        job_id: numParam().describe("Job ID"),
      },
    },
    async ({ project, job_id }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const job = await client.getJob(projectId, job_id);

        const duration = job.duration ? `${Math.round(job.duration)}s` : "N/A";
        const queuedDuration = job.queuedDuration ? `${job.queuedDuration}s` : "N/A";

        const lines = [
          `Job #${job.id}: ${job.name}`,
          ``,
          `Status: ${job.status.toUpperCase()}`,
          `Stage: ${job.stage}`,
          `Ref: ${job.ref}${job.tag ? " (tag)" : ""}`,
          `Allow Failure: ${job.allowFailure ? "Yes" : "No"}`,
          ``,
          `Created: ${formatDate(job.createdAt)}`,
          `Started: ${job.startedAt ? formatDate(job.startedAt) : "N/A"}`,
          `Finished: ${job.finishedAt ? formatDate(job.finishedAt) : "N/A"}`,
          `Duration: ${duration}`,
          `Queued: ${queuedDuration}`,
          ``,
          `Pipeline: #${job.pipeline.id} (${job.pipeline.status})`,
          `Commit: ${job.commit.shortId} - ${job.commit.title}`,
          `User: ${job.user?.name || "N/A"}`,
          ``,
          `URL: ${job.webUrl}`,
        ];

        if (job.failureReason) {
          lines.push("", `Failure Reason: ${job.failureReason}`);
        }

        if (job.runner) {
          lines.push("", `Runner: ${job.runner.description} (#${job.runner.id})`);
        }

        if (job.artifacts && job.artifacts.length > 0) {
          lines.push("", "Artifacts:");
          for (const artifact of job.artifacts) {
            const size = artifact.size > 1024 * 1024
              ? `${(artifact.size / 1024 / 1024).toFixed(1)}MB`
              : `${(artifact.size / 1024).toFixed(1)}KB`;
            lines.push(`  - ${artifact.filename} (${artifact.fileType}, ${size})`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_get_job", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_run_pipeline",
    {
      description: "Trigger a new pipeline on a branch or tag.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        ref: z.string().describe("Branch or tag name to run the pipeline on"),
        variables: z.array(z.object({
          key: z.string().describe("Variable name"),
          value: z.string().describe("Variable value"),
          variable_type: z.enum(["env_var", "file"]).optional().default("env_var").describe("Variable type"),
        })).optional().describe("Pipeline variables"),
      },
    },
    async ({ project, ref, variables }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const pipeline = await client.createPipeline(
          projectId,
          ref,
          variables?.map((v) => ({ key: v.key, value: v.value, variableType: v.variable_type }))
        );

        const lines = [
          `Triggered pipeline #${pipeline.id} on ${ref}`,
          `Status: ${pipeline.status.toUpperCase()}`,
          `SHA: ${pipeline.sha.slice(0, 8)}`,
          `Created: ${formatDate(pipeline.createdAt)}`,
          `URL: ${pipeline.webUrl}`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return mcpToolError("gitlab_run_pipeline", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_retry_pipeline",
    {
      description: "Retry failed jobs in a pipeline.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        pipeline_id: numParam().describe("Pipeline ID"),
      },
    },
    async ({ project, pipeline_id }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const pipeline = await client.retryPipeline(projectId, pipeline_id);

        return {
          content: [{
            type: "text",
            text: `Retrying pipeline #${pipeline.id} on ${pipeline.ref}\nStatus: ${pipeline.status.toUpperCase()}\nURL: ${pipeline.webUrl}`,
          }],
        };
      } catch (e) {
        return mcpToolError("gitlab_retry_pipeline", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_cancel_pipeline",
    {
      description: "Cancel a running pipeline.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        pipeline_id: numParam().describe("Pipeline ID"),
      },
    },
    async ({ project, pipeline_id }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        const pipeline = await client.cancelPipeline(projectId, pipeline_id);

        return {
          content: [{
            type: "text",
            text: `Cancelled pipeline #${pipeline.id} on ${pipeline.ref}\nStatus: ${pipeline.status.toUpperCase()}\nURL: ${pipeline.webUrl}`,
          }],
        };
      } catch (e) {
        return mcpToolError("gitlab_cancel_pipeline", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_delete_pipeline",
    {
      description: "Delete a pipeline record. This does not cancel the pipeline — use gitlab_cancel_pipeline first if it is still running.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        pipeline_id: numParam().describe("Pipeline ID"),
      },
    },
    async ({ project, pipeline_id }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        await client.deletePipeline(projectId, pipeline_id);

        return {
          content: [{
            type: "text",
            text: `Deleted pipeline #${pipeline_id}.`,
          }],
        };
      } catch (e) {
        return mcpToolError("gitlab_delete_pipeline", "pipeline-tools.ts", e);
      }
    }
  );

  server.registerTool(
    "gitlab_get_job_log",
    {
      description: "Get the log output of a job.",
      inputSchema: {
        project: z.string().optional().describe("Project path/ID (default: current repo)"),
        job_id: numParam().describe("Job ID"),
        tail: numParam().optional().describe("Only return the last N lines of the log"),
      },
    },
    async ({ project, job_id, tail }) => {
      try {
        const client = getGitLabClient();
        const projectId = resolveProject(project);
        let log = await client.getJobLog(projectId, job_id);

        log = log.replace(/\x1b\[[0-9;]*m/g, "");

        if (tail && tail > 0) {
          const lines = log.split("\n");
          log = lines.slice(-tail).join("\n");
        }

        const maxLength = 50000;
        if (log.length > maxLength) {
          log = `[Log truncated, showing last ${maxLength} characters]\n...\n${log.slice(-maxLength)}`;
        }

        return { content: [{ type: "text", text: `Job #${job_id} Log:\n\n${log}` }] };
      } catch (e) {
        return mcpToolError("gitlab_get_job_log", "pipeline-tools.ts", e);
      }
    }
  );
}
