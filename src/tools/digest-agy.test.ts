import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecretFile } from "./digest-agy.tool.js";

test("credential files are withheld from digests", () => {
  for (const p of [
    "/repo/.env",
    "/repo/.env.local",
    "/repo/apps/api/.env.production",
    "/repo/.npmrc",
    "/home/u/.netrc",
    "/home/u/.ssh/id_ed25519",
    "/repo/certs/server.pem",
    "/repo/tls.key",
    "/repo/credentials.json",
    "/repo/infra/prod.tfvars",
  ]) {
    assert.ok(isSecretFile(p), p);
  }
});

test("templates and ordinary sources are not treated as secrets", () => {
  for (const p of [
    "/repo/.env.example",
    "/repo/.env.sample",
    "/repo/src/env.ts",
    "/repo/src/keyboard.ts",
    "/repo/README.md",
    "/repo/package.json",
  ]) {
    assert.ok(!isSecretFile(p), p);
  }
});

test("files under credential directories are withheld whatever their name", () => {
  for (const p of [
    "/home/u/.aws/credentials",
    "/home/u/.ssh/config",
    "/home/u/.kube/config",
    "/home/u/.docker/config.json",
    "/home/u/.config/gcloud/application_default_credentials.json",
    "/repo/.envrc",
    "/repo/infra/terraform.tfstate.backup",
    "/repo/infra/prod.tfvars.json",
  ]) {
    assert.ok(isSecretFile(p), p);
  }
  assert.ok(!isSecretFile("/repo/docker/Dockerfile"));
});

async function makeTree() {
  const fs = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agy-digest-")));
  const repo = join(base, "repo");
  const outside = join(base, "outside");
  fs.mkdirSync(join(repo, "src"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(join(repo, ".gitignore"), "dist/\n");
  fs.writeFileSync(
    join(repo, "blob"),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]),
  );
  fs.writeFileSync(join(repo, "big.txt"), "x".repeat(50_000));
  fs.writeFileSync(join(outside, "secret.ts"), "export const k = 'outside';\n");
  fs.symlinkSync(outside, join(repo, "link-out"));
  return { fs, base, repo, outside };
}

const OPTS = {
  recursive: true,
  exclude: [] as string[],
  maxBytesPerFile: 2048,
  maxTotalBytes: 1_000_000,
};

test("collectFiles skips paths that resolve outside workingDir", async () => {
  const { collectFiles } = await import("./digest-agy.tool.js");
  const { fs, base, repo, outside } = await makeTree();
  try {
    const stats = collectFiles(
      [`${outside}/secret.ts`, "../outside", "link-out", "src"],
      repo,
      OPTS,
    );
    assert.deepEqual(
      stats.files.map((f) => f.rel),
      ["src/a.ts"],
    );
    assert.deepEqual(stats.outsideSkipped, [
      `${outside}/secret.ts`,
      "../outside",
      "link-out",
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("collectFiles drops extensionless binaries, keeps dot-files, caps reads", async () => {
  const { collectFiles } = await import("./digest-agy.tool.js");
  const { fs, base, repo } = await makeTree();
  try {
    const stats = collectFiles(["."], repo, OPTS);
    const rels = stats.files.map((f) => f.rel).sort();
    assert.deepEqual(rels, [".gitignore", "big.txt", "src/a.ts"]);
    const big = stats.files.find((f) => f.rel === "big.txt")!;
    assert.equal(big.content.length, 2048);
    assert.equal(big.truncated, true);
    assert.equal(big.size, 50_000);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
