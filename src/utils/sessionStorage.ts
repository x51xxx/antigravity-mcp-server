import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { join, basename, dirname } from "path";
import { Logger } from "./logger.js";

/**
 * Session storage for Antigravity MCP server.
 *
 * Two layers:
 *   1. Workspace isolation (MD5 of repo:head:path) — prevents cross-project leakage.
 *   2. Native Antigravity conversation ID — passed back to `agy --conversation <id>`.
 *
 * Configurable via AGY_SESSION_TTL_MS (default 24h) and AGY_MAX_SESSIONS (default 50).
 */

const SESSION_TTL_MS =
  parseInt(process.env.AGY_SESSION_TTL_MS || "", 10) || 24 * 60 * 60 * 1000;
const MAX_SESSIONS = parseInt(process.env.AGY_MAX_SESSIONS || "", 10) || 50;

export interface SessionData {
  sessionId: string;
  workspaceId: string;
  /** Native Antigravity conversation ID for `agy --conversation <id>` resume. */
  conversationId?: string;
  lastPrompt: string;
  lastResponse: string;
  model?: string;
  workingDir?: string;
  createdAt: number;
  updatedAt: number;
}

const sessionStore = new Map<string, SessionData>();

function findGitRoot(startPath: string): string | null {
  let currentPath = startPath;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(currentPath, ".git"))) return currentPath;
    const parent = dirname(currentPath);
    if (parent === currentPath) break;
    currentPath = parent;
  }
  return null;
}

function readGitHead(gitRoot: string | null): string {
  if (!gitRoot) return "";
  try {
    const headPath = join(gitRoot, ".git", "HEAD");
    if (existsSync(headPath)) return readFileSync(headPath, "utf8").trim();
  } catch (error) {
    Logger.debug("Failed to read git HEAD:", error);
  }
  return "";
}

export function generateWorkspaceId(workingDir: string): string {
  const gitRoot = findGitRoot(workingDir);
  const repoName = basename(gitRoot || workingDir);
  const headContent = readGitHead(gitRoot);
  const hashInput = `${repoName}:${headContent}:${workingDir}`;
  return createHash("md5").update(hashInput).digest("hex").substring(0, 12);
}

export function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `agy_${timestamp}_${random}`;
}

function cleanupSessions(): void {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, s] of sessionStore.entries()) {
    if (now - s.updatedAt > SESSION_TTL_MS) expired.push(id);
  }
  for (const id of expired) sessionStore.delete(id);

  if (sessionStore.size > MAX_SESSIONS) {
    const sorted = Array.from(sessionStore.entries()).sort(
      ([, a], [, b]) => a.updatedAt - b.updatedAt,
    );
    for (const [id] of sorted.slice(0, sessionStore.size - MAX_SESSIONS)) {
      sessionStore.delete(id);
    }
  }
}

export function saveSession(
  data: Partial<SessionData> & { sessionId: string },
): SessionData {
  cleanupSessions();
  const existing = sessionStore.get(data.sessionId);
  const now = Date.now();
  const session: SessionData = {
    sessionId: data.sessionId,
    workspaceId: data.workspaceId || existing?.workspaceId || "",
    conversationId: data.conversationId || existing?.conversationId,
    lastPrompt: data.lastPrompt || existing?.lastPrompt || "",
    lastResponse: data.lastResponse || existing?.lastResponse || "",
    model: data.model || existing?.model,
    workingDir: data.workingDir || existing?.workingDir,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  sessionStore.set(data.sessionId, session);
  return session;
}

export function getSession(sessionId: string): SessionData | null {
  const session = sessionStore.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessionStore.delete(sessionId);
    return null;
  }
  return session;
}

export function getSessionByWorkspace(workspaceId: string): SessionData | null {
  cleanupSessions();
  let mostRecent: SessionData | null = null;
  for (const s of sessionStore.values()) {
    if (s.workspaceId === workspaceId) {
      if (!mostRecent || s.updatedAt > mostRecent.updatedAt) mostRecent = s;
    }
  }
  return mostRecent;
}

export function getOrCreateSession(
  workingDir: string,
  sessionId?: string,
): SessionData {
  const workspaceId = generateWorkspaceId(workingDir);
  if (sessionId) {
    const existing = getSession(sessionId);
    if (existing) return existing;
    return saveSession({
      sessionId,
      workspaceId,
      workingDir,
      lastPrompt: "",
      lastResponse: "",
    });
  }
  const workspaceSession = getSessionByWorkspace(workspaceId);
  if (workspaceSession) return workspaceSession;
  return saveSession({
    sessionId: generateSessionId(),
    workspaceId,
    workingDir,
    lastPrompt: "",
    lastResponse: "",
  });
}

export function setConversationId(
  sessionId: string,
  conversationId: string,
): void {
  const session = getSession(sessionId);
  if (session) saveSession({ ...session, conversationId });
}

export function getConversationId(sessionId: string): string | undefined {
  return getSession(sessionId)?.conversationId;
}

export function listSessions(): SessionData[] {
  cleanupSessions();
  return Array.from(sessionStore.values()).sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

export function deleteSession(sessionId: string): boolean {
  return sessionStore.delete(sessionId);
}

export function clearAllSessions(): void {
  sessionStore.clear();
}

/**
 * Per-session execution lock. MCP clients usually call tools serially, but the
 * MCP SDK's request handler is invoked concurrently when multiple requests
 * arrive in flight. Without this, two back-to-back ask-antigravity calls with
 * the same sessionId both read an empty conversationId and spawn independent
 * conversations, defeating resume.
 *
 * Usage:
 *     await withSessionLock(sessionId, async () => { ... });
 */
const sessionLocks = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(
  sessionId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sessionId) return fn();
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(fn, fn); // run regardless of previous outcome
  const tracked = next.catch(() => undefined);
  sessionLocks.set(sessionId, tracked);
  try {
    return await next;
  } finally {
    if (sessionLocks.get(sessionId) === tracked) {
      sessionLocks.delete(sessionId);
    }
  }
}

export function getSessionStats(): {
  total: number;
  withResume: number;
  maxSessions: number;
  ttlMs: number;
} {
  cleanupSessions();
  let withResume = 0;
  for (const s of sessionStore.values()) {
    if (s.conversationId) withResume++;
  }
  return {
    total: sessionStore.size,
    withResume,
    maxSessions: MAX_SESSIONS,
    ttlMs: SESSION_TTL_MS,
  };
}
