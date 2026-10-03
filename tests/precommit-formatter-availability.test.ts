import assert from "node:assert/strict";
import { resolve } from "node:path";

const fixtureRoot = resolve(".cleanup-evidence/precommit-fixtures");
const stagedSource = "export const selected=1\n";
const formattedSource = "export const selected = 1;\n";
const foreignStaged = "foreign staged content\n";
const foreignWorking = "foreign unstaged content\n";
const nonstagedSource = "export const nonstaged=2\n";
const decoder = new TextDecoder();

type Fixture = { path: string; environment: Record<string, string> };

function command(fixture: Fixture, executable: string, args: string[]) {
  return new Deno.Command(executable, {
    args,
    cwd: fixture.path,
    clearEnv: true,
    env: fixture.environment,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

async function git(fixture: Fixture, ...args: string[]) {
  const result = await command(fixture, "git", args);
  assert.equal(result.code, 0, decoder.decode(result.stderr));
  return decoder.decode(result.stdout);
}

async function createFixture(): Promise<Fixture> {
  await Deno.mkdir(fixtureRoot, { recursive: true });
  const path = await Deno.makeTempDir({ dir: fixtureRoot, prefix: "hook-" });
  const fixture = {
    path,
    environment: {
      PATH: `${path}/bin:/usr/bin:/bin`,
      HOME: path,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: `${path}/empty-git-config`,
    },
  };
  await Deno.mkdir(`${path}/bin`);
  await Deno.mkdir(`${path}/.githooks`);
  await Deno.writeTextFile(`${path}/empty-git-config`, "");
  await Deno.writeTextFile(`${path}/.githooks/pre-commit`, await Deno.readTextFile(".githooks/pre-commit"));
  await Deno.writeTextFile(`${path}/bin/deno`, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> .deno-calls\n", { mode: 0o755 });
  await git(fixture, "-c", "init.templateDir=", "init", "--quiet", "--initial-branch=fixture");
  await Deno.writeTextFile(`${path}/selected.ts`, stagedSource);
  await Deno.writeTextFile(`${path}/foreign.txt`, foreignStaged);
  await git(fixture, "add", "--", "selected.ts", "foreign.txt");
  await Deno.writeTextFile(`${path}/foreign.txt`, foreignWorking);
  await Deno.writeTextFile(`${path}/nonstaged.ts`, nonstagedSource);
  return fixture;
}

async function assertForeignState(fixture: Fixture) {
  assert.equal(await git(fixture, "show", ":foreign.txt"), foreignStaged);
  assert.equal(await Deno.readTextFile(`${fixture.path}/foreign.txt`), foreignWorking);
  assert.equal(await Deno.readTextFile(`${fixture.path}/nonstaged.ts`), nonstagedSource);
  assert.equal(await git(fixture, "diff", "--cached", "--name-only"), "foreign.txt\nselected.ts\n");
  assert.equal(await git(fixture, "ls-files", "--", "nonstaged.ts"), "");
}

Deno.test("pre-commit fails with install guidance when staged TypeScript has no Prettier", async () => {
  const fixture = await createFixture();
  try {
    const indexBefore = await Deno.readFile(`${fixture.path}/.git/index`);
    const result = await command(fixture, "/bin/sh", [".githooks/pre-commit"]);
    const stderr = decoder.decode(result.stderr);
    assert.equal(result.code, 1, stderr);
    assert.match(stderr, /Prettier is not installed/);
    assert.match(stderr, /run 'bun install' in tools\/lint then 'sh scripts\/format\.sh'/);
    assert.deepEqual(await Deno.readFile(`${fixture.path}/.git/index`), indexBefore);
    assert.equal(await git(fixture, "show", ":selected.ts"), stagedSource);
    assert.equal(await Deno.readTextFile(`${fixture.path}/selected.ts`), stagedSource);
    await assert.rejects(Deno.stat(`${fixture.path}/.deno-calls`), Deno.errors.NotFound);
    await assertForeignState(fixture);
    console.log(JSON.stringify({ case: "absent-formatter", hookExit: result.code, guidance: stderr.trim(), indexPreserved: true }));
  } finally {
    await Deno.remove(fixture.path, { recursive: true });
  }
});

Deno.test("pre-commit invokes the owning formatter and restages its repaired TypeScript", async () => {
  const fixture = await createFixture();
  try {
    const formatter = `${fixture.path}/tools/lint/node_modules/.bin`;
    await Deno.mkdir(formatter, { recursive: true });
    await Deno.writeTextFile(
      `${formatter}/prettier`,
      `#!/bin/sh\nset -eu\n[ "$#" -eq 2 ] && [ "$1" = "--write" ] && [ "$2" = "selected.ts" ] || exit 70\nprintf '%s\\n' "$*" > .prettier-calls\nprintf 'export const selected = 1;\\n' > "$2"\n`,
      { mode: 0o755 }
    );
    const result = await command(fixture, "/bin/sh", [".githooks/pre-commit"]);
    assert.equal(result.code, 0, decoder.decode(result.stderr));
    assert.equal(await Deno.readTextFile(`${fixture.path}/.prettier-calls`), "--write selected.ts\n");
    assert.equal(await Deno.readTextFile(`${fixture.path}/selected.ts`), formattedSource);
    assert.equal(await git(fixture, "show", ":selected.ts"), formattedSource);
    assert.deepEqual((await Deno.readTextFile(`${fixture.path}/.deno-calls`)).trim().split("\n"), [
      "lint --fix selected.ts",
      "lint selected.ts",
      "fmt --check serve.ts src tests scripts docs",
      "task build",
      "check tests",
    ]);
    await assertForeignState(fixture);
    console.log(JSON.stringify({ case: "owning-formatter", hookExit: result.code, repairedSourceRestaged: true, foreignStatePreserved: true }));
  } finally {
    await Deno.remove(fixture.path, { recursive: true });
  }
});
