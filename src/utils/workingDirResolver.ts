import { existsSync, statSync } from "fs";
import { dirname, resolve, isAbsolute } from "path";
import { Logger } from "./logger.js";

const PROJECT_MARKERS = [
  "package.json",
  ".git",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
] as const;

const MAX_WALK_UP_LEVELS = 10;

export function findProjectRoot(startPath: string): string {
  try {
    let currentDir = ensureDirectory(startPath);
    if (!currentDir) return startPath;

    let levelsWalked = 0;
    while (levelsWalked < MAX_WALK_UP_LEVELS) {
      for (const marker of PROJECT_MARKERS) {
        const markerPath = resolve(currentDir, marker);
        if (existsSync(markerPath)) {
          Logger.debug(
            `Found project root at: ${currentDir} (marker: ${marker})`,
          );
          return currentDir;
        }
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
      levelsWalked++;
    }
    return ensureDirectory(startPath) || startPath;
  } catch (error) {
    Logger.debug(`Error in findProjectRoot: ${error}`);
    return startPath;
  }
}

export function ensureDirectory(
  path?: string,
  baseDir: string = process.cwd(),
): string | undefined {
  if (!path) return undefined;
  try {
    const absolutePath = isAbsolute(path) ? path : resolve(baseDir, path);
    if (!existsSync(absolutePath)) return undefined;
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) return absolutePath;
    if (stats.isFile()) return dirname(absolutePath);
    return undefined;
  } catch (error) {
    Logger.debug(`Error in ensureDirectory: ${error}`);
    return undefined;
  }
}

/**
 * Extract @path references from prompt and resolve them.
 * Mirrors codex-mcp-tool behaviour so users can drop @path/to/file in prompts.
 */
export function extractPathFromAtSyntax(
  prompt: string,
  baseDir: string = process.cwd(),
): string[] {
  const paths: string[] = [];

  // An @ glued to a preceding word character is an e-mail address or similar
  // (user@host/path), not a file reference.
  const quotedPathRegex = /(?<![\w.%+-])@["']([^"']+)["']/g;
  let match;
  while ((match = quotedPathRegex.exec(prompt)) !== null) {
    const p = match[1];
    paths.push(isAbsolute(p) ? p : resolve(baseDir, p));
  }

  const absolutePathRegex = /(?<![\w.%+-])@(\/[^\s"']+)/g;
  while ((match = absolutePathRegex.exec(prompt)) !== null) {
    paths.push(match[1]);
  }

  const relativePathRegex =
    /(?<![\w.%+-])@(\.{1,2}\/[^\s"']+|[a-zA-Z0-9_-]+\/[^\s"']+)/g;
  while ((match = relativePathRegex.exec(prompt)) !== null) {
    paths.push(resolve(baseDir, match[1]));
  }

  return paths;
}

/**
 * Resolve working directory using the same fallback chain as codex-mcp-tool,
 * but keyed off AGY_MCP_CWD instead.
 */
export function resolveWorkingDirectory(options?: {
  workingDir?: string;
  prompt?: string;
}): string | undefined {
  const { workingDir, prompt } = options || {};

  const baseDir =
    process.env["AGY_MCP_CWD"] ||
    process.env["PWD"] ||
    process.env["INIT_CWD"] ||
    process.cwd();

  if (workingDir) {
    const validDir = ensureDirectory(workingDir, baseDir);
    if (validDir) return validDir;
    // Never fall back silently: running an agent (possibly with
    // --dangerously-skip-permissions) in a different directory than the
    // caller asked for is worse than failing.
    throw new Error(
      `Working directory does not exist: ${workingDir} (resolved against ${baseDir})`,
    );
  }

  // Order: explicit workingDir → AGY_MCP_CWD (explicit config) → @path in the
  // prompt → the server's launch dir (PWD / INIT_CWD). PWD is practically
  // always set, so checking it before @path made @path references dead code.
  const fromEnv = (name: "AGY_MCP_CWD" | "PWD" | "INIT_CWD") => {
    const v = process.env[name];
    return v ? ensureDirectory(v, process.cwd()) : null;
  };

  const configured = fromEnv("AGY_MCP_CWD");
  if (configured) return configured;

  if (prompt) {
    const paths = extractPathFromAtSyntax(prompt, baseDir);
    for (const p of paths) {
      if (existsSync(p)) {
        const projectRoot = findProjectRoot(p);
        if (projectRoot) return projectRoot;
      }
    }
  }

  return fromEnv("PWD") || fromEnv("INIT_CWD") || process.cwd();
}
