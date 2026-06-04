/**
 * Per-session working directory context for HTTP mode.
 *
 * In stdio mode the MCP server process inherits the user's project CWD, so
 * process.cwd() is correct. In HTTP/SSE mode the server is a long-lived process
 * whose CWD never changes — getEffectiveCwd() reads the AsyncLocalStorage store
 * that server.ts populates from the ?cwd= query param on each SSE/Streamable
 * connection. Falls back to GITLAB_PROJECT_DIR env var, then process.cwd().
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface SessionContext {
  cwd: string;
}

export const sessionStorage = new AsyncLocalStorage<SessionContext>();

/**
 * Return the working directory that should be used for git root detection in
 * the current async context. Priority:
 *   1. AsyncLocalStorage (set per HTTP session from ?cwd= query param)
 *   2. GITLAB_PROJECT_DIR env var
 *   3. process.cwd() (correct in stdio mode)
 */
export function getEffectiveCwd(): string {
  return (
    sessionStorage.getStore()?.cwd ??
    process.env.GITLAB_PROJECT_DIR ??
    process.cwd()
  );
}
