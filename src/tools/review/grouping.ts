/**
 * Smart file grouping for MR review chunks.
 * Groups changed files by directory/module for parallel review.
 */

import type { GitLabMRChange } from "../../types.js";

export interface ReviewChunk {
  /** Stable identifier for this chunk, e.g. "src-api" or "tests-unit" */
  chunkId: string;
  /** Human-readable group name, e.g. "src/api/ (3 files)" */
  groupName: string;
  /** File paths in this chunk */
  files: string[];
  /** Total lines added across files in this chunk */
  totalAdditions: number;
  /** Total lines deleted across files in this chunk */
  totalDeletions: number;
  /** Rough token estimate (for caller to gauge subagent load) */
  estimatedTokens: number;
}

export interface ReviewManifest {
  mrIid: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  totalFiles: number;
  totalChunks: number;
  chunks: ReviewChunk[];
  overflowWarning?: string;
}

/**
 * Estimate diff size in tokens (rough: ~4 chars per token).
 */
function estimateTokens(diff: string): number {
  return Math.ceil(diff.length / 4);
}

/**
 * Count additions and deletions from a diff string.
 */
function countChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Generate a stable chunk ID from a directory path.
 */
function makeChunkId(dirPath: string): string {
  if (!dirPath || dirPath === ".") return "root";
  return dirPath.replace(/\//g, "-").replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();
}

/**
 * Get the grouping directory for a file path.
 * Returns the first two directory levels, or "root" for top-level files.
 */
function getGroupDir(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return ".";
  // Use up to 2 directory levels for grouping
  if (parts.length <= 2) return parts[0];
  return parts.slice(0, 2).join("/");
}

/** Config file patterns that get their own group */
const CONFIG_PATTERNS = [
  /^\./, // dotfiles at root
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig/,
  /^\.eslintrc/,
  /^\.prettierrc/,
  /^Makefile$/,
  /^Dockerfile/,
  /^docker-compose/,
  /^\.gitlab-ci/,
  /^\.github\//,
  /^Cargo\.toml$/,
  /^go\.(mod|sum)$/,
  /^requirements.*\.txt$/,
  /^pyproject\.toml$/,
  /^setup\.(py|cfg)$/,
];

function isConfigFile(filePath: string): boolean {
  const basename = filePath.split("/").pop() || filePath;
  // Root-level config files only (not nested ones)
  if (filePath.includes("/") && !filePath.startsWith(".")) return false;
  return CONFIG_PATTERNS.some((p) => p.test(basename) || p.test(filePath));
}

/** Large file threshold: if a single file has this many changed lines, it becomes its own chunk */
const LARGE_FILE_THRESHOLD = 500;

/** Max files per group before sub-grouping */
const MAX_FILES_PER_GROUP = 10;

/**
 * Group changed files into review chunks using smart directory-based grouping.
 *
 * Strategy:
 * 1. Config/root files get their own "config" chunk
 * 2. Files are grouped by common directory prefix (2 levels deep)
 * 3. If a group has >10 files, sub-group by next directory level
 * 4. If a single file has >500 changed lines, it becomes its own chunk
 * 5. Orphan files (unique directories with 1-2 files) are grouped into "misc"
 */
export function groupFilesIntoChunks(
  changes: GitLabMRChange[]
): ReviewChunk[] {
  const chunks: ReviewChunk[] = [];

  // Separate config files
  const configFiles: Array<{ change: GitLabMRChange; stats: { additions: number; deletions: number }; tokens: number }> = [];
  const regularFiles: Array<{ change: GitLabMRChange; stats: { additions: number; deletions: number }; tokens: number; groupDir: string }> = [];

  for (const change of changes) {
    const stats = countChanges(change.diff);
    const tokens = estimateTokens(change.diff);
    const filePath = change.newPath || change.oldPath;

    if (isConfigFile(filePath)) {
      configFiles.push({ change, stats, tokens });
    } else {
      regularFiles.push({ change, stats, tokens, groupDir: getGroupDir(filePath) });
    }
  }

  // Add config chunk if any
  if (configFiles.length > 0) {
    chunks.push({
      chunkId: "config",
      groupName: `Config files (${configFiles.length} file${configFiles.length > 1 ? "s" : ""})`,
      files: configFiles.map((f) => f.change.newPath || f.change.oldPath),
      totalAdditions: configFiles.reduce((sum, f) => sum + f.stats.additions, 0),
      totalDeletions: configFiles.reduce((sum, f) => sum + f.stats.deletions, 0),
      estimatedTokens: configFiles.reduce((sum, f) => sum + f.tokens, 0),
    });
  }

  // Group regular files by directory
  const groups = new Map<string, typeof regularFiles>();
  for (const file of regularFiles) {
    const totalChanges = file.stats.additions + file.stats.deletions;

    // Large files get their own chunk
    if (totalChanges > LARGE_FILE_THRESHOLD) {
      const filePath = file.change.newPath || file.change.oldPath;
      chunks.push({
        chunkId: makeChunkId(filePath),
        groupName: `${filePath} (large file)`,
        files: [filePath],
        totalAdditions: file.stats.additions,
        totalDeletions: file.stats.deletions,
        estimatedTokens: file.tokens,
      });
      continue;
    }

    if (!groups.has(file.groupDir)) {
      groups.set(file.groupDir, []);
    }
    groups.get(file.groupDir)!.push(file);
  }

  // Process groups
  const orphans: typeof regularFiles = [];

  for (const [dir, files] of groups) {
    // Orphan detection: groups with 1-2 files from unique directories
    if (files.length <= 2 && groups.size > 3) {
      orphans.push(...files);
      continue;
    }

    // Large groups: sub-group by next directory level
    if (files.length > MAX_FILES_PER_GROUP) {
      const subGroups = new Map<string, typeof regularFiles>();
      for (const file of files) {
        const filePath = file.change.newPath || file.change.oldPath;
        const parts = filePath.split("/");
        const subDir = parts.length > 2 ? parts.slice(0, 3).join("/") : dir;
        if (!subGroups.has(subDir)) {
          subGroups.set(subDir, []);
        }
        subGroups.get(subDir)!.push(file);
      }

      for (const [subDir, subFiles] of subGroups) {
        chunks.push({
          chunkId: makeChunkId(subDir),
          groupName: `${subDir}/ (${subFiles.length} file${subFiles.length > 1 ? "s" : ""})`,
          files: subFiles.map((f) => f.change.newPath || f.change.oldPath),
          totalAdditions: subFiles.reduce((sum, f) => sum + f.stats.additions, 0),
          totalDeletions: subFiles.reduce((sum, f) => sum + f.stats.deletions, 0),
          estimatedTokens: subFiles.reduce((sum, f) => sum + f.tokens, 0),
        });
      }
      continue;
    }

    // Normal group
    chunks.push({
      chunkId: makeChunkId(dir),
      groupName: `${dir}/ (${files.length} file${files.length > 1 ? "s" : ""})`,
      files: files.map((f) => f.change.newPath || f.change.oldPath),
      totalAdditions: files.reduce((sum, f) => sum + f.stats.additions, 0),
      totalDeletions: files.reduce((sum, f) => sum + f.stats.deletions, 0),
      estimatedTokens: files.reduce((sum, f) => sum + f.tokens, 0),
    });
  }

  // Add orphans as a misc chunk
  if (orphans.length > 0) {
    chunks.push({
      chunkId: "misc",
      groupName: `Other files (${orphans.length} file${orphans.length > 1 ? "s" : ""})`,
      files: orphans.map((f) => f.change.newPath || f.change.oldPath),
      totalAdditions: orphans.reduce((sum, f) => sum + f.stats.additions, 0),
      totalDeletions: orphans.reduce((sum, f) => sum + f.stats.deletions, 0),
      estimatedTokens: orphans.reduce((sum, f) => sum + f.tokens, 0),
    });
  }

  return chunks;
}

/**
 * Format a ReviewManifest as human-readable text that Claude can parse.
 */
export function formatManifest(manifest: ReviewManifest): string {
  const lines = [
    `## MR Review Manifest: !${manifest.mrIid} - "${manifest.title}"`,
    `Author: @${manifest.author} | Branch: ${manifest.sourceBranch} -> ${manifest.targetBranch}`,
    `Total: ${manifest.totalFiles} files changed across ${manifest.totalChunks} review chunks`,
    "",
  ];

  if (manifest.overflowWarning) {
    lines.push(`WARNING: ${manifest.overflowWarning}`);
    lines.push("");
  }

  for (let i = 0; i < manifest.chunks.length; i++) {
    const chunk = manifest.chunks[i];
    lines.push(`### Chunk ${i + 1}: ${chunk.groupName}`);
    lines.push(`ID: ${chunk.chunkId} | Changes: +${chunk.totalAdditions} -${chunk.totalDeletions} (~${chunk.estimatedTokens} tokens est.)`);
    lines.push(`Files: ${chunk.files.join(", ")}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("To review each chunk, call gitlab_get_review_chunk with the chunk_id from above.");

  return lines.join("\n");
}
