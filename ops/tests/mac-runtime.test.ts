import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MAC_RUNTIME, prepareMacRuntime } from "../mac-runtime.ts";

const FIXTURES = fileURLToPath(new URL("../../.cleanup-evidence/mac-runtime-fixtures", import.meta.url));
const decoder = new TextDecoder();
const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
const sha256 = async (value: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
type Failure = "archive" | "length" | "binary" | "unzip" | "member" | "redirect";
const dependencies = async (failure?: Failure) => {
  const archive = bytes("synthetic-archive");
  const binary = bytes("synthetic-binary");
  const artifact = {
    ...MAC_RUNTIME,
    archiveBytes: archive.length,
    archiveSha256: await sha256(archive),
    binaryBytes: binary.length,
    binarySha256: await sha256(binary),
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = () => {
    calls.push("download");
    if (failure === "redirect")
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://unapproved.example.invalid/archive" } }));
    const content = failure === "archive" ? bytes("incorrect-archive") : archive;
    return Promise.resolve(
      new Response(new Uint8Array(content), { headers: { "content-length": String(failure === "length" ? archive.length + 1 : archive.length) } })
    );
  };
  const unzip = (args: string[]): Promise<Deno.CommandOutput> => {
    calls.push(args.slice(0, 2).join(" "));
    let stdout = binary;
    if (args[1] === "-1") stdout = bytes(failure === "member" ? "deno\nunexpected\n" : "deno\n");
    if (args[1] === "-l") stdout = bytes("-rwxr-xr-x 3.0 unx 16 bx 10 defN deno\n");
    if (args[0] === "-p" && failure === "binary") stdout = bytes("incorrect-binary");
    return Promise.resolve({ success: failure !== "unzip", code: failure === "unzip" ? 1 : 0, signal: null, stdout, stderr: new Uint8Array() });
  };
  return { artifact, os: "darwin" as const, arch: "aarch64" as const, fetch: fetcher, unzip, calls };
};
const root = async (): Promise<string> => {
  await Deno.mkdir(FIXTURES, { recursive: true });
  return await Deno.realPath(await Deno.makeTempDir({ dir: FIXTURES, prefix: "case-" }));
};
const clean = async (path: string): Promise<void> => {
  const runtimeStore = path + "/.data/runtimes/deno";
  try {
    for await (const item of Deno.readDir(runtimeStore)) {
      const entry = runtimeStore + "/" + item.name;
      const info = await Deno.lstat(entry);
      if (info.isDirectory && !info.isSymlink) await Deno.chmod(entry, 0o700);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.remove(path, { recursive: true });
};
const entries = async (path: string): Promise<string[]> => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names.sort((left, right) => left.localeCompare(right));
};

Deno.test("Mac runtime uses the exact official immutable artifact pin", () => {
  assert.equal(MAC_RUNTIME.version, "2.9.5");
  assert.equal(MAC_RUNTIME.archiveBytes, 38511993);
  assert.equal(MAC_RUNTIME.binaryBytes, 80900512);
  assert.equal(MAC_RUNTIME.archiveSha256, "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615");
  assert.equal(MAC_RUNTIME.binarySha256, "b5bd08edab254d42d7b05aa5b6cb4c9b8d4dede4975aff76951ce2cce18866fa");
  assert.equal(MAC_RUNTIME.url, "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip");
});
Deno.test("Mac runtime verifies, publishes readonly bytes and reuses without downloading", async () => {
  const path = await root();
  try {
    const test = await dependencies();
    const binary = await prepareMacRuntime(path, test);
    assert.equal(await Deno.readTextFile(binary), "synthetic-binary");
    const binaryMode = (await Deno.stat(binary)).mode;
    const directoryMode = (await Deno.stat(binary.slice(0, binary.lastIndexOf("/")))).mode;
    const storeMode = (await Deno.stat(path + "/.data/runtimes/deno")).mode;
    assert(binaryMode !== null && directoryMode !== null && storeMode !== null);
    assert.equal(binaryMode & 0o777, 0o500);
    assert.equal(directoryMode & 0o777, 0o500);
    assert.equal(storeMode & 0o777, 0o700);
    const calls = test.calls.slice();
    assert.equal(await prepareMacRuntime(path, test), binary);
    assert.deepEqual(test.calls, calls);
    assert.deepEqual(await entries(path + "/.data/runtimes/deno"), ["2.9.5-" + test.artifact.binarySha256]);
  } finally {
    await clean(path);
  }
});
for (const failure of ["archive", "length", "binary", "unzip", "member", "redirect"] as const) {
  Deno.test("Mac runtime preparation preserves live state on " + failure + " failure", async () => {
    const path = await root();
    try {
      await Deno.mkdir(path + "/.data", { recursive: true });
      await Deno.writeTextFile(path + "/.data/current", "prior-selector");
      await Deno.writeTextFile(path + "/service-state", "prior-service");
      await assert.rejects(prepareMacRuntime(path, await dependencies(failure)));
      assert.equal(await Deno.readTextFile(path + "/.data/current"), "prior-selector");
      assert.equal(await Deno.readTextFile(path + "/service-state"), "prior-service");
      assert.deepEqual(await entries(path + "/.data/runtimes/deno"), []);
    } finally {
      await clean(path);
    }
  });
}
for (const kind of ["corrupt", "symlink", "binary-symlink", "platform"] as const) {
  Deno.test("Mac runtime refuses " + kind + " without fallback or overwrite", async () => {
    const path = await root();
    try {
      const test = await dependencies();
      const destination = path + "/.data/runtimes/deno/2.9.5-" + test.artifact.binarySha256;
      if (kind === "platform") {
        await assert.rejects(prepareMacRuntime(path, { ...test, arch: "x86_64" }));
      } else {
        await Deno.mkdir(destination, { recursive: true });
        const content = kind === "corrupt" ? "foreign-corrupt-bytes" : "synthetic-binary";
        if (kind === "binary-symlink") {
          await Deno.writeTextFile(path + "/correct-binary", content);
          const linked = await new Deno.Command("/bin/ln", { args: ["-s", path + "/correct-binary", destination + "/deno"] }).output();
          assert.equal(linked.code, 0, decoder.decode(linked.stderr));
        } else await Deno.writeTextFile(destination + "/deno", content);
        if (kind === "symlink") {
          await Deno.rename(destination, destination + "-target");
          const link = await new Deno.Command("/bin/ln", { args: ["-s", destination + "-target", destination] }).output();
          assert.equal(link.code, 0, decoder.decode(link.stderr));
        }
        await assert.rejects(prepareMacRuntime(path, test));
        assert.equal(await Deno.readTextFile(destination + "/deno"), content);
      }
      assert.deepEqual(test.calls, []);
    } finally {
      await clean(path);
    }
  });
}

const bounded = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Disposable Mac deploy exceeded10s"));
        }, 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const stub = async (path: string, name: string, body: string): Promise<void> => {
  await Deno.writeTextFile(path + "/bin/" + name, "#!/bin/sh\nset -eu\n" + body + "\n");
  await Deno.chmod(path + "/bin/" + name, 0o700);
};
const deployFixture = async (path: string, failure: boolean): Promise<{ source: string; sha: string }> => {
  const sha = "a".repeat(40);
  const journal = path + "/journal";
  await Deno.mkdir(path + "/bin", { recursive: true });
  await Deno.mkdir(path + "/ops", { recursive: true });
  await Deno.mkdir(path + "/library", { recursive: true });
  await Deno.mkdir(path + "/.data/releases", { recursive: true });
  await Deno.writeTextFile(path + "/.data/current", "prior-selector");
  await Deno.writeTextFile(path + "/service-state", "prior-service");
  await Deno.writeTextFile(path + "/deno.json", '{"workspace":[],"nodeModulesDir":"none"}\n');
  await Deno.writeTextFile(path + "/deno.lock", '{"version":"5","specifiers":{}}\n');
  const log = (event: string): string => "printf '%s\\n' " + quote(event) + " >> " + quote(journal);
  await stub(
    path,
    "git",
    'case "$1" in status) exit 0 ;; rev-parse) printf "%s\\n" ' + quote(sha) + " ;; archive) " + log("archive") + '; : > "$' + '{3#--output=}" ;; esac'
  );
  await stub(path, "tar", log("tar") + '; mkdir -p "$4/src"');
  await stub(path, "id", 'printf "501\\n"');
  await stub(path, "ps", log("old-process-settled") + "; exit 1");
  await stub(
    path,
    "launchctl",
    'case "$1" in print) printf "\\n pid = 999999\\n" ;; bootout) ' + log("bootout") + " ;; bootstrap) " + log("bootstrap") + " ;; esac"
  );
  const test = await dependencies(failure ? "archive" : undefined);
  const helperUrl = new URL("../mac-runtime.ts", import.meta.url).href;
  const helper =
    "import { prepareMacRuntime as prepare } from " +
    JSON.stringify(helperUrl) +
    ";\n" +
    "const journal = " +
    JSON.stringify(journal) +
    ";\n" +
    "export const prepareMacRuntime = async (root) => {\n" +
    "await Deno.writeTextFile(journal, 'prepare-start\\n', { append: true });\n" +
    "const artifact = " +
    JSON.stringify(test.artifact) +
    ";\n" +
    "const fetcher = () => Promise.resolve(new Response(new TextEncoder().encode(" +
    JSON.stringify(failure ? "incorrect-archive" : "synthetic-archive") +
    "), {headers:{'content-length':String(artifact.archiveBytes)}}));\n" +
    "const unzip = (args) => Promise.resolve({success:true,code:0,signal:null,stdout:new TextEncoder().encode(args[1]==='-1'?'deno\\n':args[1]==='-l'?'-rwxr-xr-x 3.0 unx 16 bx 10 defN deno\\n':'synthetic-binary'),stderr:new Uint8Array()});\n" +
    "const binary = await prepare(root, {artifact,fetch:fetcher,unzip,os:'darwin',arch:'aarch64'});\n" +
    "await Deno.writeTextFile(journal, 'prepare-ready\\n', {append:true});\nreturn binary;\n};\n";
  await Deno.writeTextFile(path + "/ops/mac-runtime.ts", helper);
  await Deno.writeTextFile(path + "/ops/release-retention.ts", "export const pruneReleases = () => Promise.resolve({removed:[]});\n");
  let source = await Deno.readTextFile(new URL("../deploy-mac.ts", import.meta.url));
  source = source
    .replaceAll("/Users/nv/repos/ubiquity/ai.ubq.fi", path)
    .replace("/Users/nv/Library/LaunchAgents/com.ubiquity.ai.local.plist", path + "/library/agent.plist");
  source = source.replace('Deno.build.os !== "darwin"', "Deno.build.os !== " + JSON.stringify(Deno.build.os));
  const prelude =
    "Deno.symlink = async (target, link) => {\n" +
    "link = new URL(link, " +
    JSON.stringify("file://" + path + "/") +
    ").pathname;\n" +
    "if (!link.startsWith(" +
    JSON.stringify(path + "/") +
    ")) throw new Error('foreign fixture symlink');\n" +
    "const result = await new Deno.Command('/bin/ln',{args:['-s',target,link]}).output();\nif (!result.success) throw new Error('fixture ln failed');\n};\n" +
    "globalThis.fetch = () => Promise.resolve(Response.json({release:{git_sha:" +
    JSON.stringify(sha) +
    ",deployment_id:" +
    JSON.stringify("mac-" + sha) +
    "}},{headers:{'x-uos-git-sha':" +
    JSON.stringify(sha) +
    ",'x-uos-deployment-id':" +
    JSON.stringify("mac-" + sha) +
    "}}));\n";
  return { source: prelude + source, sha };
};
for (const failure of [false, true]) {
  Deno.test("Mac deploy actual entry prepares runtime before selection/service effects: " + String(failure), async () => {
    const path = await root();
    let child: Deno.ChildProcess | undefined;
    try {
      const fixture = await deployFixture(path, failure);
      await Deno.writeTextFile(path + "/ops/deploy-mac.ts", fixture.source);
      const programs = ["git", "tar", "id", "ps", "launchctl"].map((name) => path + "/bin/" + name);
      const args = [
        "-c",
        'exec "$@"',
        "--",
        Deno.execPath(),
        "run",
        "--frozen",
        "--no-prompt",
        "--allow-read=" + path,
        "--allow-write=" + path,
        "--allow-run=/bin/ln," + programs.join(","),
        path + "/ops/deploy-mac.ts",
      ];
      child = new Deno.Command("/bin/sh", {
        args,
        cwd: path,
        clearEnv: true,
        env: { PATH: path + "/bin:/usr/bin:/bin", HOME: path, TMPDIR: path, DENO_DIR: path + "/cache" },
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = await bounded(child.output());
      const journal = (await Deno.readTextFile(path + "/journal")).trim().split("\n");
      if (failure) {
        assert.notEqual(output.code, 0);
        assert.deepEqual(journal, ["prepare-start"]);
        assert.equal(await Deno.readTextFile(path + "/.data/current"), "prior-selector");
        assert.equal(await Deno.readTextFile(path + "/service-state"), "prior-service");
      } else {
        assert.equal(output.code, 0, decoder.decode(output.stderr));
        assert.deepEqual(journal, ["prepare-start", "prepare-ready", "archive", "tar", "bootout", "old-process-settled", "bootstrap"]);
        assert.equal(await Deno.readLink(path + "/.data/current"), "releases/" + fixture.sha);
      }
    } finally {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already reaped */
        }
        await bounded(child.status);
      }
      await clean(path);
    }
  });
}
