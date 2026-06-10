# GitLab MCP Server

An MCP server for the GitLab API: repositories, commits, merge requests, issues, discussions,
labels, pipelines/jobs, and a draft-based code-review workflow. See [Available Tools](#available-tools)
for the full list.

Runs as a local `stdio` server or a hosted HTTP server with GitLab OAuth. Inside a git repo with a
GitLab remote, most tools need no parameters — the instance, project, and token are read from the
local environment.

## Requirements

- Node.js 22+
- A GitLab personal access token (see [GitLab Token](#gitlab-token))

## GitLab Token

Create a personal access token at GitLab **Settings → Access Tokens**. Choose scopes based on which
tools you intend to use:

- `read_api` — read-only tools (browsing repos, commits, MRs, issues, pipelines)
- `api` — required for any write tool (creating MRs, managing issues, running/retrying pipelines,
  creating access tokens)
- `read_repository` — reading file contents and trees

## Usage (local / stdio mode)

The server is published to npm and can be run with `npx`, so no clone or build step is required.

### Claude Code

```bash
claude mcp add gitlab -- npx -y gitlab-forge-mcp
```

### Other MCP clients

Add the server to your client's MCP config (e.g. `~/.config/claude-code/settings.json`,
`claude_desktop_config.json`, or a Cursor `mcp.json`):

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "gitlab-forge-mcp"]
    }
  }
}
```

### Authentication

Provide a token in one of the following ways (checked in this order):

1. A `.gitlab-token` file in the git root:
   ```bash
   echo "your-personal-access-token" > .gitlab-token
   echo ".gitlab-token" >> .gitignore   # don't commit it
   ```
2. A `GITLAB_TOKEN` environment variable.
3. A matching `machine`/`password` entry in `~/.netrc`:
   ```
   machine gitlab.com
   login your-username
   password your-token
   ```

## Configuration

The server resolves its settings from the surrounding git repository:

| Setting | Resolution order |
|---------|------------------|
| GitLab URL | `GITLAB_URL` env var → git remote origin → `https://gitlab.com` |
| Project | tool parameter → git remote origin path |
| Token | `.gitlab-token` file in git root → `GITLAB_TOKEN` env var → `~/.netrc` password |

## Building from source

To run a local checkout instead of the published package:

```bash
git clone https://github.com/steppestone/gitlab-mcp.git
cd gitlab-mcp
npm install
npm run build
```

Then point your MCP client at the built entry point (add an `env` block with `GITLAB_TOKEN` if you
aren't using a `.gitlab-token` file or `.netrc`):

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/path/to/gitlab-mcp/dist/server.js"]
    }
  }
}
```

## Self-hosting (HTTP / OAuth mode)

In addition to local `stdio` mode, the server can run as a hosted HTTP endpoint that
authenticates clients with **GitLab OAuth** (Streamable HTTP transport). This lets multiple
users connect to one shared deployment.

Start it with `--port`:

```bash
node dist/server.js --port 8000
```

Configure it with environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_URL` | yes | Public base URL of this server, e.g. `https://gitlab-mcp.example.com` |
| `GITLAB_OAUTH_CLIENT_ID` | yes | GitLab OAuth application client ID |
| `GITLAB_OAUTH_CLIENT_SECRET` | yes | GitLab OAuth application client secret |
| `GITLAB_TOKEN` | yes | Shared PAT used for GitLab API calls |
| `GITLAB_URL` | no | GitLab instance URL (default `https://gitlab.com`) |
| `ALLOWED_GITLAB_USERS` | no | Comma-separated GitLab usernames allowed to connect |

Create the GitLab OAuth application (GitLab → **Settings → Applications**) with:
- **Redirect URI**: `<BASE_URL>/auth/callback`
- **Scopes**: `read_user`, `openid`

### Docker

```bash
docker build -t gitlab-mcp .
docker run -p 8000:8000 \
  -e BASE_URL=https://gitlab-mcp.example.com \
  -e GITLAB_OAUTH_CLIENT_ID=... \
  -e GITLAB_OAUTH_CLIENT_SECRET=... \
  -e GITLAB_TOKEN=... \
  gitlab-mcp
```

### Kubernetes

Deploy the container with a standard Deployment + Service + Ingress. Supply the environment
variables above (`BASE_URL`, OAuth client ID/secret, `GITLAB_TOKEN`, …) via a `Secret`, and
create that `Secret` out-of-band — never commit real secrets to the repo. The container listens
on port `8000`.

## Available Tools

43 tools are registered. Tools marked **✏️ write** modify GitLab; those marked **📢 external**
create content visible to others and require explicit confirmation before they act.

### Status
- `gitlab_status` - Show current configuration: detected project, branch, GitLab URL, and auth status

### Project Tools
- `gitlab_get_project` - Get information about a GitLab project
- `gitlab_list_projects` - List projects accessible to the authenticated user

### Repository Tools
- `gitlab_list_branches` - List branches in a project
- `gitlab_list_commits` - List commits (filter by branch, path, date range)
- `gitlab_get_commit` - Get details of a specific commit including its diff
- `gitlab_get_file` - Get contents of a file from the repository
- `gitlab_list_tree` - List files and directories in a repository path

### Compare Tools
- `gitlab_compare` - Compare two branches, tags, or commits to see the differences

### Issue Tools
- `gitlab_list_issues` - List issues in a project
- `gitlab_get_issue` - Get details of a specific issue
- `gitlab_update_issue` - **✏️ write** Update an issue's title, description, assignees, labels, state, or milestone
- `gitlab_close_issue` - **✏️ write** Close an issue
- `gitlab_reopen_issue` - **✏️ write** Reopen a closed issue

### Merge Request Tools
- `gitlab_list_merge_requests` - List merge requests in a project
- `gitlab_get_merge_request` - Get details of a specific merge request
- `gitlab_get_merge_request_changes` - Get the diff/changes for a merge request
- `gitlab_get_merge_request_commits` - List commits in a merge request
- `gitlab_get_mr_pipelines` - List pipelines associated with a merge request
- `gitlab_create_merge_request` - **✏️ write 📢 external** Create a new MR (shows a preview; requires `confirm=true`)

### Discussion Tools
- `gitlab_list_mr_discussions` - List MR discussion threads (excludes resolved by default)
- `gitlab_list_mr_notes` - List notes (comments) on an MR in flat format (excludes resolved/system notes by default)
- `gitlab_resolve_mr_discussion` - **✏️ write** Resolve or unresolve a discussion thread

### Draft Review Note Tools
Queue review comments privately, then publish them as a batch. Drafts are only visible to you until published.
- `gitlab_list_mr_draft_notes` - List your pending (draft) review comments on an MR
- `gitlab_create_mr_draft_note` - **✏️ write** Queue a review comment without publishing (supports diff-line positions and threaded replies)
- `gitlab_update_mr_draft_note` - **✏️ write** Edit a queued draft note before publishing
- `gitlab_delete_mr_draft_note` - **✏️ write** Discard a queued draft note without publishing it
- `gitlab_publish_mr_draft_note` - **✏️ write 📢 external** Publish a single queued draft note (requires confirmation)
- `gitlab_publish_mr_draft_notes` - **✏️ write 📢 external** Bulk-publish ALL queued draft notes on an MR (requires confirmation)

### Label Tools
- `gitlab_search_labels` - Search for labels in a project (returns all labels when no search term is given)

### Access Token Tools
- `gitlab_create_project_access_token` - **✏️ write** Create a project access token (requires Owner/Maintainer; secret is returned once)
- `gitlab_create_personal_access_token` - **✏️ write** Create a personal access token via the admin endpoint (requires instance admin; secret is returned once)

### Pipeline & Job Tools
- `gitlab_list_pipelines` - List pipelines in a project
- `gitlab_get_pipeline` - Get details of a specific pipeline
- `gitlab_list_pipeline_jobs` - List jobs in a pipeline (grouped by stage)
- `gitlab_get_job` - Get details of a specific job
- `gitlab_get_job_log` - Get the log output of a job (with tail and ANSI stripping)
- `gitlab_run_pipeline` - **✏️ write** Trigger a new pipeline on a branch or tag
- `gitlab_retry_pipeline` - **✏️ write** Retry failed jobs in a pipeline
- `gitlab_cancel_pipeline` - **✏️ write** Cancel a running pipeline
- `gitlab_delete_pipeline` - **✏️ write** Delete a pipeline record (does not cancel; cancel first if still running)

### Review Orchestration Tools
- `gitlab_prepare_mr_review` - Prepare a large MR for chunked review (returns a manifest of file groups)
- `gitlab_get_review_chunk` - Get full untruncated diffs for a review chunk (optionally with discussions/commits)

## Reviewing Large MRs

The review orchestration tools enable parallel review of large merge requests by breaking them into manageable chunks that can be delegated to subagents.

### Workflow

1. **Prepare**: Call `gitlab_prepare_mr_review` with the MR IID. Returns a manifest with chunks grouped by directory/module.

2. **Delegate**: For each chunk in the manifest, call `gitlab_get_review_chunk` with the `chunk_id`. Each call returns full untruncated diffs for that group of files.

3. **Control detail level**: Use the `detail_level` parameter:
   - `diff` (default) - Just the code changes
   - `diff_discussions` - Changes + existing review comments on those files
   - `full` - Changes + discussions + commit messages

### Chunking Strategy

Files are grouped by the following rules:
- **Config files** (package.json, tsconfig, etc.) get their own chunk
- **Directory grouping** - Files grouped by first 2 directory levels
- **Large files** (>500 changed lines) become standalone chunks
- **Sub-grouping** - Directories with >10 files are split further
- **Orphan collection** - Single files from unique directories grouped as "misc"

### Example

```
# Step 1: Get the review manifest
gitlab_prepare_mr_review mr_iid=123

# Step 2: Review each chunk (can be parallelized to subagents)
gitlab_get_review_chunk mr_iid=123 chunk_id="src-api" detail_level="diff_discussions"
gitlab_get_review_chunk mr_iid=123 chunk_id="src-components" detail_level="diff"
gitlab_get_review_chunk mr_iid=123 chunk_id="tests" detail_level="diff"
gitlab_get_review_chunk mr_iid=123 chunk_id="config" detail_level="diff"
```

## Development

Run in development mode:
```bash
npm run dev      # or: pnpm run dev
```

## License

[MIT](LICENSE) © Björn Mosten
