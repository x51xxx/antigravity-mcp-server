import { z } from "zod";
import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import { join, resolve, isAbsolute, extname } from "path";
import { UnifiedTool } from "./registry.js";
import { executeAgy } from "../utils/agyExecutor.js";
import { formatAgyResponseForMCP } from "../utils/outputParser.js";
import { createAgyError, formatErrorForUser } from "../utils/errorTypes.js";
import { resolveWorkingDirectory } from "../utils/workingDirResolver.js";
import { Logger } from "../utils/logger.js";

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
      "Files or directories to ingest. Directories are walked. Globs are NOT expanded — pass concrete paths.",
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
  timeout: z.number().optional(),
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
  ".env.example",
  ".gitignore",
  ".dockerignore",
  "",
]);

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
  totalBytes: number;
  hitTotalCap: boolean;
}

function looksTextLike(p: string): boolean {
  const ext = extname(p);
  if (TEXT_LIKE.has(ext)) return true;
  // Allow special files without ext (Dockerfile, Makefile, etc.)
  const base = p.split("/").pop() || "";
  return /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG)/.test(base);
}

function collectFiles(
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
    totalBytes: 0,
    hitTotalCap: false,
  };
  const seen = new Set<string>();

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
      st = statSync(absPath);
    } catch {
      stats.skipped++;
      return;
    }

    const rel = absPath.startsWith(workingDir)
      ? absPath.slice(workingDir.length + 1)
      : absPath;
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
      const buf = readFileSync(absPath);
      const slice = buf.slice(0, opts.maxBytesPerFile);
      content = slice.toString("utf8");
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
    visit(abs, 0);
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
    `\n# CONTEXT (${files.length} files)`,
    fileBlocks,
  ].join("\n");
}

export const digestAgyTool: UnifiedTool = {
  name: "digest-antigravity",
  description:
    "Ingest many files at once and answer a focused question. Uses Antigravity's large model context (Gemini ~1M tokens) to swallow whole modules / docs that don't fit in the caller's context. Walks directories, filters by extension, truncates oversized files, caps total payload. Returns a concentrated brief.",
  zodSchema: digestArgsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
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
      return `❌ No readable text files found under: ${paths.join(", ")}\nSkipped: ${stats.skipped}`;
    }

    const banner = `📦 digest: ${stats.files.length} files, ${(stats.totalBytes / 1024).toFixed(1)} KB${stats.hitTotalCap ? " (hit total-byte cap)" : ""}`;
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
          workingDir,
          timeout: args.timeout as number | undefined,
          // Long prompts go via stdin automatically (>100K).
          useStdinForLongPrompts: true,
        },
        onProgress,
      );

      const text = formatAgyResponseForMCP(result.output, result.stderr, "clean");

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
      return `❌ ${formatErrorForUser(agyErr)}`;
    }
  },
};
