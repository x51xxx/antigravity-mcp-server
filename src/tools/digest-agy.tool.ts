import { z } from "zod";
import {
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "fs";
import {
  join,
  resolve,
  isAbsolute,
  extname,
  basename,
  relative,
  sep,
} from "path";
import { UnifiedTool, toolError } from "./registry.js";
import { executeAgy } from "../utils/agyExecutor.js";
import { formatAgyResponseForMCP } from "../utils/outputParser.js";
import { createAgyError, formatErrorForUser } from "../utils/errorTypes.js";
import { resolveWorkingDirectory } from "../utils/workingDirResolver.js";
import { Logger } from "../utils/logger.js";
import { effortSchema } from "./sharedSchemas.js";
import { READ_ONLY_PROMPT_NOTE } from "../constants.js";

const digestArgsSchema = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      'Focused question to answer using the provided files (e.g., "explain auth flow", "find dead code").',
    ),
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      "Files or directories to ingest, inside workingDir (symlinks are resolved; anything outside is skipped). Directories are walked. Globs are NOT expanded — pass concrete paths.",
    ),
  workingDir: z.string().optional(),
  recursive: z
    .boolean()
    .optional()
    .default(true)
    .describe("Walk into subdirectories. Default: true."),
  extensions: z
    .array(z.string())
    .optional()
    .describe(
      'Filter by extensions when walking dirs (e.g., [".ts", ".tsx"]). Default: all text-like files.',
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe(
      "Substrings to exclude from paths (matched against relative path). Default: node_modules, .git, dist, build.",
    ),
  maxBytesPerFile: z
    .number()
    .int()
    .min(1024)
    .optional()
    .default(200_000)
    .describe("Truncate any single file above this size. Default: 200 KB."),
  maxTotalBytes: z
    .number()
    .int()
    .min(10_000)
    .optional()
    .default(8 * 1024 * 1024)
    .describe(
      "Stop adding files once the total payload exceeds this. Gemini models have ~1M-token contexts; 8 MB default leaves headroom.",
    ),
  shape: z
    .enum(["summary", "detailed", "qa"])
    .optional()
    .default("qa")
    .describe(
      "summary: 1-paragraph; detailed: structured deep-dive; qa: focused answer to the question.",
    ),
  model: z.string().optional(),
  effort: effortSchema,
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum execution time in milliseconds (default 600000)"),
});

const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  ".next/",
  "__pycache__/",
  ".venv/",
  ".cache/",
  ".turbo/",
];

const TEXT_LIKE = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
]);

/** Extensionless or dot-files that are text (extname(".gitignore") is ""). */
const TEXT_LIKE_NAMES = new Set([
  ".gitignore",
  ".dockerignore",
  ".env.example",
]);

/**
 * Files that typically hold credentials. They are never sent to the model,
 * even when named explicitly — the payload leaves the machine.
 */
const SECRET_FILE_RE = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production …
  /^\.(npmrc|yarnrc\.yml|pypirc|netrc|git-credentials|htpasswd|pgpass|envrc)$/i,
  /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /\.(tfvars|tfstate)(\.json|\.backup)?$/i,
  /^(credentials|service-account|secrets?)(\..+)?\.(json|ya?ml|toml)$/i,
];
const SECRET_TEMPLATE_RE = /\.(example|sample|template|dist)$/i;

/**
 * Directories whose files are credentials or credential config
 * (~/.aws/credentials, ~/.ssh/config, ~/.kube/config, ~/.docker/config.json …),
 * whatever the file name.
 */
const SECRET_DIRS = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
]);

export function isSecretFile(p: string): boolean {
  const base = basename(p);
  if (SECRET_TEMPLATE_RE.test(base)) return false;
  const segments = p.split(/[\\/]/).slice(0, -1);
  if (segments.some((s) => SECRET_DIRS.has(s))) return true;
  if (segments.join("/").includes(".config/gcloud")) return true;
  return SECRET_FILE_RE.some((re) => re.test(base));
}

interface CollectedFile {
  path: string;
  rel: string;
  size: number;
  truncated: boolean;
  content: string;
}

interface CollectStats {
  files: CollectedFile[];
  skipped: number;
  /** Credential-like files that were withheld (relative paths). */
  secretsSkipped: string[];
  /** Requested paths that resolve outside workingDir (as given). */
  outsideSkipped: string[];
  totalBytes: number;
  hitTotalCap: boolean;
}

function looksTextLike(p: string): boolean {
  const ext = extname(p);
  if (ext && TEXT_LIKE.has(ext)) return true;
  const base = basename(p);
  if (TEXT_LIKE_NAMES.has(base)) return true;
  // Allow special files without ext (Dockerfile, Makefile, etc.)
  return /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG)/.test(base);
}

/** Read at most `max` bytes from the start of a file (never the whole file). */
function readHead(absPath: string, max: number): Buffer {
  const buf = Buffer.alloc(max);
  const fd = openSync(absPath, "r");
  try {
    let n = 0;
    while (n < max) {
      const got = readSync(fd, buf, n, max - n, n);
      if (got === 0) break;
      n += got;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function collectFiles(
  rootPaths: string[],
  workingDir: string,
  opts: {
    recursive: boolean;
    extensions?: string[];
    exclude: string[];
    maxBytesPerFile: number;
    maxTotalBytes: number;
  },
): CollectStats {
  const stats: CollectStats = {
    files: [],
    skipped: 0,
    secretsSkipped: [],
    outsideSkipped: [],
    totalBytes: 0,
    hitTotalCap: false,
  };
  const seen = new Set<string>();

  // Everything read is sent to the model, so roots are confined to the
  // workspace by their real path (a symlinked root can point anywhere).
  let workspace: string;
  try {
    workspace = realpathSync(workingDir);
  } catch {
    workspace = resolve(workingDir);
  }
  const insideWorkspace = (p: string): boolean => {
    const r = relative(workspace, p);
    return (
      r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r))
    );
  };

  const allowExt = (p: string): boolean => {
    if (opts.extensions && opts.extensions.length > 0) {
      return opts.extensions.some((e) => p.endsWith(e));
    }
    return looksTextLike(p);
  };

  const excluded = (rel: string): boolean =>
    opts.exclude.some((x) => rel.includes(x));

  const visit = (absPath: string, depth: number): void => {
    if (stats.hitTotalCap) return;
    if (seen.has(absPath)) return;
    seen.add(absPath);

    let st;
    try {
      // Don't follow symlinks below the explicit roots: a link can point
      // anywhere on disk (e.g. ~/.ssh) and the content is sent to the model.
      if (depth > 0 && lstatSync(absPath).isSymbolicLink()) {
        stats.skipped++;
        return;
      }
      st = statSync(absPath);
    } catch {
      stats.skipped++;
      return;
    }

    const rel = relative(workspace, absPath);
    if (excluded(rel)) {
      stats.skipped++;
      return;
    }

    if (st.isDirectory()) {
      // Always iterate the explicit roots (depth 0). For deeper levels obey `recursive`.
      if (depth > 0 && !opts.recursive) return;
      let entries: string[];
      try {
        entries = readdirSync(absPath);
      } catch {
        return;
      }
      for (const e of entries) visit(join(absPath, e), depth + 1);
      return;
    }

    if (!st.isFile()) return;
    if (isSecretFile(absPath)) {
      stats.secretsSkipped.push(rel);
      return;
    }
    if (!allowExt(absPath)) {
      stats.skipped++;
      return;
    }

    const readSize = Math.min(st.size, opts.maxBytesPerFile);
    if (stats.totalBytes + readSize > opts.maxTotalBytes) {
      stats.hitTotalCap = true;
      return;
    }

    let content: string;
    try {
      content = readHead(absPath, readSize).toString("utf8");
      // Skip files that look binary (high ratio of \0)
      if (content.indexOf("\0") >= 0 && content.indexOf("\0") < 1000) {
        stats.skipped++;
        return;
      }
    } catch (err) {
      Logger.debug(`Skipping ${absPath}: ${err}`);
      stats.skipped++;
      return;
    }

    stats.files.push({
      path: absPath,
      rel,
      size: st.size,
      truncated: st.size > opts.maxBytesPerFile,
      content,
    });
    stats.totalBytes += readSize;
  };

  for (const p of rootPaths) {
    const abs = isAbsolute(p) ? p : resolve(workingDir, p);
    if (!existsSync(abs)) {
      stats.skipped++;
      continue;
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      stats.skipped++;
      continue;
    }
    if (!insideWorkspace(real)) {
      stats.outsideSkipped.push(p);
      continue;
    }
    visit(real, 0);
  }

  return stats;
}

function buildPrompt(
  question: string,
  files: CollectedFile[],
  shape: string,
): string {
  const shapeInstructions: Record<string, string> = {
    summary: "Answer with a single tight paragraph (5-8 sentences).",
    detailed:
      "Produce a structured answer with headings: Summary, Key Findings, File-by-File Notes, Open Questions.",
    qa: "Answer the question directly and concisely. Include specific file:line references where relevant. Skip preamble.",
  };

  const fileBlocks = files
    .map(
      (f) =>
        `\n=== FILE: ${f.rel} (${f.size} bytes${f.truncated ? ", TRUNCATED" : ""}) ===\n${f.content}`,
    )
    .join("\n");

  return [
    `# QUESTION`,
    question,
    `\n# INSTRUCTIONS`,
    shapeInstructions[shape] || shapeInstructions.qa,
    `Answer from the CONTEXT below. ${READ_ONLY_PROMPT_NOTE}`,
    `\n# CONTEXT (${files.length} files)`,
    fileBlocks,
  ].join("\n");
}

export const digestAgyTool: UnifiedTool = {
  name: "digest-antigravity",
  description:
    "Ingest many files at once and answer a focused question. Uses Antigravity's large model context (Gemini ~1M tokens) to swallow whole modules / docs that don't fit in the caller's context. Walks directories (symlinks are not followed), filters by extension, withholds credential files (.env, .npmrc, keys…), truncates oversized files, caps total payload. Returns a concentrated brief.",
  zodSchema: digestArgsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    // The file contents go to the Antigravity backend.
    openWorldHint: true,
  },
  category: "utility",
  execute: async (args, onProgress) => {
    const question = (args.question as string).trim();
    const paths = args.paths as string[];
    if (!question) throw new Error("question is required");
    if (!paths?.length) throw new Error("at least one path is required");

    const workingDir =
      resolveWorkingDirectory({
        workingDir: args.workingDir as string | undefined,
        prompt: question,
      }) || process.cwd();

    const exclude = ((args.exclude as string[] | undefined) ?? []).concat(
      DEFAULT_EXCLUDES,
    );
    const stats = collectFiles(paths, workingDir, {
      recursive: args.recursive !== false,
      extensions: args.extensions as string[] | undefined,
      exclude,
      maxBytesPerFile: (args.maxBytesPerFile as number) || 200_000,
      maxTotalBytes: (args.maxTotalBytes as number) || 8 * 1024 * 1024,
    });

    if (stats.files.length === 0) {
      return toolError(
        `❌ No readable text files found under: ${paths.join(", ")}\nSkipped: ${stats.skipped}${stats.outsideSkipped.length ? `\nOutside workingDir (${workingDir}): ${stats.outsideSkipped.join(", ")} — set workingDir to digest another directory.` : ""}`,
      );
    }

    const banner = `📦 digest: ${stats.files.length} files, ${(stats.totalBytes / 1024).toFixed(1)} KB${stats.hitTotalCap ? " (hit total-byte cap)" : ""}${stats.secretsSkipped.length ? `\n🔒 withheld ${stats.secretsSkipped.length} credential-like file(s): ${stats.secretsSkipped.join(", ")}` : ""}${stats.outsideSkipped.length ? `\n🚫 skipped ${stats.outsideSkipped.length} path(s) outside ${workingDir}: ${stats.outsideSkipped.join(", ")}` : ""}`;
    Logger.log(banner);

    const prompt = buildPrompt(
      question,
      stats.files,
      (args.shape as string) || "qa",
    );

    try {
      const result = await executeAgy(
        prompt,
        {
          model: args.model as string | undefined,
          effort: args.effort as string | undefined,
          workingDir,
          timeout: args.timeout as number | undefined,
          // The payload is untrusted file content: never let it drive edits.
          readOnly: true,
          // Long prompts go via stdin automatically (>100K).
          useStdinForLongPrompts: true,
        },
        onProgress,
      );

      const text = formatAgyResponseForMCP(
        result.output,
        result.stderr,
        "clean",
      );

      return {
        text: `${banner}\n\n${text}`,
        structuredContent: {
          ingested: stats.files.map((f) => ({
            path: f.rel,
            size: f.size,
            truncated: f.truncated,
          })),
          totalBytes: stats.totalBytes,
          skipped: stats.skipped,
          secretsSkipped: stats.secretsSkipped,
          outsideSkipped: stats.outsideSkipped,
          hitTotalCap: stats.hitTotalCap,
          answer: text,
        },
      };
    } catch (error) {
      const agyErr = createAgyError(
        error instanceof Error ? error : String(error),
        {
          workingDir,
        },
      );
      return toolError(`❌ ${formatErrorForUser(agyErr)}`);
    }
  },
};
