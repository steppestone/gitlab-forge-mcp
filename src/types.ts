/**
 * GitLab API type definitions.
 */

export interface GitLabConfig {
  baseUrl: string;
  token: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  nameWithNamespace: string;
  path: string;
  pathWithNamespace: string;
  description: string | null;
  defaultBranch: string;
  visibility: string;
  webUrl: string;
  sshUrlToRepo: string;
  httpUrlToRepo: string;
  createdAt: string;
  lastActivityAt: string;
}

export interface GitLabBranch {
  name: string;
  commit: {
    id: string;
    shortId: string;
    title: string;
    authorName: string;
    authoredDate: string;
  };
  merged: boolean;
  protected: boolean;
  default: boolean;
  webUrl: string;
}

export interface GitLabCommit {
  id: string;
  shortId: string;
  title: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredDate: string;
  committerName: string;
  committerEmail: string;
  committedDate: string;
  webUrl: string;
  parentIds: string[];
}

export interface GitLabCommitDiff {
  oldPath: string;
  newPath: string;
  aMode: string;
  bMode: string;
  diff: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  state: string;
  avatarUrl: string;
  webUrl: string;
}

export interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  mergedBy: GitLabUser | null;
  mergedAt: string | null;
  closedBy: GitLabUser | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targetBranch: string;
  sourceBranch: string;
  author: GitLabUser;
  assignee: GitLabUser | null;
  assignees: GitLabUser[];
  reviewers: GitLabUser[];
  sourceProjectId: number;
  targetProjectId: number;
  labels: string[];
  draft: boolean;
  workInProgress: boolean;
  milestone: GitLabMilestone | null;
  mergeWhenPipelineSucceeds: boolean;
  mergeStatus: string;
  sha: string;
  webUrl: string;
  diffRefs: {
    baseSha: string;
    headSha: string;
    startSha: string;
  } | null;
  hasConflicts: boolean;
  changesCount: string | null;
  userNotesCount: number;
}

export interface GitLabMilestone {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  dueDate: string | null;
  startDate: string | null;
  webUrl: string;
}

export interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedBy: GitLabUser | null;
  author: GitLabUser;
  assignee: GitLabUser | null;
  assignees: GitLabUser[];
  labels: string[];
  milestone: GitLabMilestone | null;
  webUrl: string;
  dueDate: string | null;
  confidential: boolean;
  userNotesCount: number;
  weight: number | null;
  timeStats: {
    timeEstimate: number;
    totalTimeSpent: number;
  };
}

export interface GitLabMRChange {
  oldPath: string;
  newPath: string;
  aMode: string;
  bMode: string;
  diff: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
}

export interface GitLabMRChanges extends GitLabMergeRequest {
  changes: GitLabMRChange[];
  overflow: boolean;
}

export interface GitLabNote {
  id: number;
  type: string | null;
  body: string;
  author: GitLabUser;
  createdAt: string;
  updatedAt: string;
  system: boolean;
  noteableId: number;
  noteableType: string;
  resolvable: boolean;
  resolved: boolean;
  resolvedBy: GitLabUser | null;
  resolvedAt: string | null;
  confidential: boolean;
  noteableIid: number;
}

export interface GitLabDiscussion {
  id: string;
  individualNote: boolean;
  notes: GitLabNote[];
}

export interface GitLabDiffNote extends GitLabNote {
  position: {
    baseSha: string;
    headSha: string;
    startSha: string;
    positionType: "text" | "image";
    oldPath: string | null;
    newPath: string | null;
    oldLine: number | null;
    newLine: number | null;
    lineRange: {
      start: { type: string; oldLine: number | null; newLine: number | null };
      end: { type: string; oldLine: number | null; newLine: number | null };
    } | null;
  };
}

export interface GitLabDraftNotePosition {
  baseSha: string;
  headSha: string;
  startSha: string;
  positionType: "text" | "image" | "file";
  oldPath?: string | null;
  newPath?: string | null;
  oldLine?: number | null;
  newLine?: number | null;
  lineRange?: unknown;
}

export interface GitLabDraftNote {
  id: number;
  authorId: number;
  mergeRequestId: number;
  resolveDiscussion: boolean;
  discussionId: string | null;
  note: string;
  commitId: string | null;
  lineCode: string | null;
  position: GitLabDraftNotePosition | null;
}

export interface GitLabPipeline {
  id: number;
  iid: number;
  projectId: number;
  sha: string;
  ref: string;
  status: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  webUrl: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: number;
  queuedDuration?: number;
  coverage?: string;
  name?: string;
}

export interface GitLabPipelineDetailed extends GitLabPipeline {
  beforeSha: string;
  tag: boolean;
  yamlErrors?: string;
  user: GitLabUser;
}

export interface GitLabJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  ref: string;
  tag: boolean;
  coverage?: number;
  allowFailure: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: number;
  queuedDuration?: number;
  user: GitLabUser;
  commit: {
    id: string;
    shortId: string;
    title: string;
    authorName: string;
    authorEmail: string;
  };
  pipeline: {
    id: number;
    iid: number;
    projectId: number;
    sha: string;
    ref: string;
    status: string;
    webUrl: string;
  };
  webUrl: string;
  artifacts: GitLabArtifact[];
  runner?: {
    id: number;
    description: string;
    active: boolean;
    isShared: boolean;
  };
  failureReason?: string;
}

export interface GitLabArtifact {
  fileType: string;
  size: number;
  filename: string;
  fileFormat?: string;
}

export interface GitLabFile {
  fileName: string;
  filePath: string;
  size: number;
  encoding: string;
  contentSha256: string;
  ref: string;
  blobId: string;
  commitId: string;
  lastCommitId: string;
  content: string;
}

export interface GitLabTreeItem {
  id: string;
  name: string;
  type: "tree" | "blob";
  path: string;
  mode: string;
}

// API Response helpers - maps snake_case API responses to camelCase
export interface GitLabLabel {
  id: number;
  name: string;
  color: string;
  textColor: string;
  description: string | null;
  openIssuesCount: number;
  closedIssuesCount: number;
  openMergeRequestsCount: number;
  subscribed: boolean;
  priority: number | null;
  isProjectLabel: boolean;
}

export interface ApiResponse<T> {
  data: T;
  headers: Record<string, string>;
}

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
  nextPage: number | null;
  prevPage: number | null;
}
