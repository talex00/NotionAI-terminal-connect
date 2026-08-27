import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("start.sh has valid Bash syntax", () => {
  const result = spawnSync(
    "bash",
    ["-n", fileURLToPath(new URL("start.sh", root))],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("package requires a supported Node.js version", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root)));
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.engines.node, ">=20");
  assert.ok(packageJson.dependencies["@modelcontextprotocol/sdk"]);
  assert.ok(packageJson.dependencies.zod);
});

test("runtime secrets and dependencies are ignored", async () => {
  const gitignore = await readFile(new URL(".gitignore", root), "utf8");
  assert.match(gitignore, /^node_modules\/$/m);
  assert.match(gitignore, /^\.runtime\/$/m);
  assert.match(gitignore, /^\.env$/m);
});
