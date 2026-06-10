#!/usr/bin/env node
/**
 * MCP Server for GitLab API integration.
 *
 * Supports two modes:
 * - stdio (default): spawned per Claude instance, no auth
 * - HTTP (--port N): hosted server with GitLab OAuth (Streamable HTTP transport)
 *
 * HTTP mode env vars:
 *   GITLAB_URL               GitLab instance URL (default: https://gitlab.com)
 *   GITLAB_TOKEN             Shared PAT for GitLab API calls
 *   GITLAB_OAUTH_CLIENT_ID   GitLab OAuth App client ID
 *   GITLAB_OAUTH_CLIENT_SECRET  GitLab OAuth App client secret
 *   BASE_URL                 Public base URL (e.g. https://gitlab-mcp.example.com)
 *   ALLOWED_GITLAB_USERS     Comma-separated GitLab usernames allowed to connect
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import express from "express";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { setMcpServer } from "./utils.js";
import { registerAllTools } from "./tools/index.js";
import { GitLabOAuthProvider, BASE_URL } from "./auth.js";
import { sessionStorage } from "./session-context.js";

function parseArgs(): { port?: number } {
  const portIdx = process.argv.indexOf("--port");
  if (portIdx === -1) return {};
  const port = parseInt(process.argv[portIdx + 1], 10);
  if (isNaN(port)) {
    console.error("Invalid port number");
    process.exit(1);
  }
  return { port };
}

function createSessionServer(): McpServer {
  const server = new McpServer({ name: "gitlab", version: "0.1.0" });
  setMcpServer(server);
  registerAllTools(server);
  return server;
}

async function startStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp(port: number): Promise<void> {
  const provider = new GitLabOAuthProvider();
  const issuerUrl = new URL(BASE_URL);

  const app = express();
  app.use(express.json());

  // OAuth: /.well-known/*, /register, /authorize, /token, /revoke
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: new URL(`${BASE_URL}/mcp`),
      scopesSupported: ["read_user", "openid"],
      resourceName: "GitLab MCP",
    }),
  );

  // GitLab OAuth callback — must come after mcpAuthRouter
  app.get("/auth/callback", (req, res) => {
    provider.handleCallback(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.status(500).send(String(err));
    });
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
  const bearerAuth = requireBearerAuth({ verifier: provider });

  /** Extract the session transport from the request or send a 400 and return null. */
  function resolveTransport(
    req: express.Request,
    res: express.Response,
    sessions: Map<string, StreamableHTTPServerTransport>,
  ): StreamableHTTPServerTransport | null {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing session" },
        id: null,
      });
      return null;
    }
    return transport;
  }

  /** Return the ?cwd= query param as a string, or undefined. */
  function queryCwd(req: express.Request): string | undefined {
    const raw = req.query.cwd;
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }

  /** Run fn inside a sessionStorage context if cwd is provided, otherwise run it directly. */
  function runWithCwd<T>(cwd: string | undefined, fn: () => T): T {
    return cwd ? sessionStorage.run({ cwd }, fn) : fn();
  }

  app.post("/mcp", bearerAuth, async (req, res) => {
    const body: unknown = req.body;
    const cwd = queryCwd(req);

    if (isInitializeRequest(body)) {
      const sessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        enableJsonResponse: false,
      });
      streamableSessions.set(sessionId, transport);
      transport.onclose = () => streamableSessions.delete(sessionId);

      const server = createSessionServer();
      await server.connect(transport);
      await runWithCwd(cwd, () =>
        transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          body,
        ),
      );
      return;
    }

    const transport = resolveTransport(req, res, streamableSessions);
    if (!transport) return;
    await runWithCwd(cwd, () =>
      transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        body,
      ),
    );
  });

  app.get("/mcp", bearerAuth, async (req, res) => {
    const transport = resolveTransport(req, res, streamableSessions);
    if (!transport) return;
    await runWithCwd(queryCwd(req), () =>
      transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      ),
    );
  });

  app.delete("/mcp", bearerAuth, async (req, res) => {
    const transport = resolveTransport(req, res, streamableSessions);
    if (!transport) return;
    await runWithCwd(queryCwd(req), () =>
      transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
      ),
    );
  });

  app.listen(port, "0.0.0.0", () => {
    console.error(`GitLab MCP (OAuth) listening on http://0.0.0.0:${port}`);
    console.error(`MCP endpoint: ${BASE_URL}/mcp`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      for (const t of streamableSessions.values()) t.close();
      process.exit(0);
    });
  }
}

async function main() {
  const { port } = parseArgs();
  if (port !== undefined) {
    await startHttp(port);
  } else {
    const server = createSessionServer();
    await startStdio(server);
  }
}

main().catch(console.error);
