# GitLab MCP Server

MCP server for GitLab API integration. Read repositories, commits, merge requests, and comments.

## Features

- **Auto-detection**: Automatically detects GitLab project from git remote
- **Flexible auth**: Supports `GITLAB_TOKEN` env var or `~/.netrc`
- **Full MR support**: List, view, and read merge request changes and discussions
- **Two run modes**: local `stdio` (one process per client, no auth) or hosted **HTTP** with GitLab OAuth

## Requirements

- Node.js 22+
- A package manager — examples use `npm`; the repo is also set up for `pnpm` (a `pnpm-lock.yaml` is checked in)
- A GitLab personal access token (see [GitLab Token](#gitlab-token))

## Installation

1. Clone and install dependencies:
   ```bash
   git clone https://github.com/steppestone/gitlab-mcp.git
   cd gitlab-mcp
   npm install      # or: pnpm install
   ```

2. Build:
   ```bash
   npm run build    # or: pnpm run build
   ```

## Setup (local / stdio mode)

Configure authentication (choose one):

   **Option A: Project-specific token file (recommended)**
   ```bash
   echo "your-personal-access-token" > .gitlab-token
   # Add to .gitignore to avoid committing
   echo ".gitlab-token" >> .gitignore
   ```

   **Option B: Environment variable**
   ```bash
   export GITLAB_TOKEN="your-personal-access-token"
   ```

   **Option C: ~/.netrc file**
   ```
   machine gitlab.com
   login your-username
   password your-token
   ```

## Configuration

The server auto-detects settings from your git repository:

| Setting | Resolution Order |
|---------|------------------|
| **GitLab URL** | 1. `GITLAB_URL` env var → 2. Git remote origin → 3. `https://gitlab.com` |
| **Project** | 1. Tool parameter → 2. Git remote origin path |
| **Token** | 1. `.gitlab-token` file in git root → 2. `GITLAB_TOKEN` env var → 3. `~/.netrc` password |

Add to your Claude Code MCP settings (`~/.config/claude-code/settings.json`):

```json
{
  "mcpServers": {
    "gitlab": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/gitlab-mcp/dist/server.js"]
    }
  }
}
```

If not using `.netrc`, add the token:
```json
{
  "mcpServers": {
    "gitlab": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/gitlab-mcp/dist/server.js"],
      "env": {
        "GITLAB_TOKEN": "your-token"
      }
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

### Status
- `gitlab_status` - Show detected configuration (project, branch, URL, auth status)

### Project Tools
- `gitlab_get_project` - Get project details
- `gitlab_list_projects` - List accessible projects

### Repository Tools
- `gitlab_list_branches` - List branches
- `gitlab_list_commits` - List commits with filters (branch, path, date range)
- `gitlab_get_commit` - Get commit details including diff
- `gitlab_get_file` - Get file contents
- `gitlab_list_tree` - List files and directories

### Merge Request Tools
- `gitlab_list_merge_requests` - List MRs with filters (state, labels, branches)
- `gitlab_get_merge_request` - Get detailed MR information
- `gitlab_get_merge_request_changes` - Get MR diff/changes
- `gitlab_get_merge_request_commits` - List commits in an MR
- `gitlab_get_mr_pipelines` - List pipelines for an MR

### Discussion Tools
- `gitlab_list_mr_discussions` - List discussion threads including inline comments
- `gitlab_list_mr_notes` - List all comments in flat format
- `gitlab_resolve_mr_discussion` - Resolve or unresolve a discussion thread

### Compare Tools
- `gitlab_compare` - Compare two branches, tags, or commits

### Pipeline Tools
- `gitlab_list_pipelines` - List project pipelines with filters
- `gitlab_get_pipeline` - Get pipeline details
- `gitlab_list_pipeline_jobs` - List jobs in a pipeline (grouped by stage)
- `gitlab_get_job` - Get job details
- `gitlab_get_job_log` - Get job log output (with tail and ANSI stripping)

### Review Orchestration Tools
- `gitlab_prepare_mr_review` - Prepare a large MR for chunked review (returns manifest of file groups)
- `gitlab_get_review_chunk` - Get full untruncated diffs for a review chunk (with optional discussions/commits)

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

Files are grouped smartly:
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

## Usage

When running from a git repository with a GitLab remote, the `project` parameter is optional:

```
# These are equivalent when in a gitlab repo:
gitlab_list_merge_requests
gitlab_list_merge_requests project="mygroup/myproject"
```

## GitLab Token

Create a personal access token at GitLab Settings > Access Tokens with these scopes:
- `read_api` - Read access to the API
- `read_repository` - Read access to repositories

## Development

Run in development mode:
```bash
npm run dev      # or: pnpm run dev
```

## License

[MIT](LICENSE) © Björn Mosten
