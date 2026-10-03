export const MAC_RUNTIME = Object.freeze({
  version: "2.9.5",
  url: "https://github.com/denoland/deno/releases/download/v2.9.5/deno-aarch64-apple-darwin.zip",
  archiveBytes: 38511993,
  archiveSha256: "b796aadd131f6930560c1ee040cf0d6f53933fbb987464e9ff46bd7ea4830615",
  binaryBytes: 80900512,
  binarySha256: "b5bd08edab254d42d7b05aa5b6cb4c9b8d4dede4975aff76951ce2cce18866fa",
});
type Artifact = { version: string; url: string; archiveBytes: number; archiveSha256: string; binaryBytes: number; binarySha256: string };
type TestDependencies = {
  artifact?: Artifact;
  os?: typeof Deno.build.os;
  arch?: typeof Deno.build.arch;
  fetch?: typeof fetch;
  unzip?: (args: string[]) => Promise<Deno.CommandOutput>;
};
const digest = async (bytes: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), (byte) => byte.toString(16).padStart(2, "0")).join("");
const existing = async (path: string): Promise<Deno.FileInfo | null> => {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return null;
  }
};
const directory = async (path: string): Promise<void> => {
  const info = await existing(path);
  if (info) {
    if (!info.isDirectory || info.isSymlink) throw new Error("Managed Mac runtime directory is not a regular directory");
  } else {
    await Deno.mkdir(path, { mode: 0o700 });
  }
};
const verifiedBinary = async (path: string, artifact: Artifact): Promise<void> => {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size !== artifact.binaryBytes || (await digest(await Deno.readFile(path))) !== artifact.binarySha256) {
    throw new Error("Managed Mac runtime binary integrity check failed");
  }
};
const archiveResponse = async (artifact: Artifact, fetcher: typeof fetch): Promise<Response> => {
  let url = new URL(artifact.url);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (url.protocol !== "https:" || url.port || !["github.com", "release-assets.githubusercontent.com"].includes(url.hostname)) {
      throw new Error("Managed Mac runtime download redirected outside approved hosts");
    }
    const response = await fetcher(url, { redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Managed Mac runtime download redirect has no location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Managed Mac runtime download failed");
    }
    return response;
  }
  throw new Error("Managed Mac runtime download exceeded its redirect bound");
};
const readArchive = async (response: Response, artifact: Artifact): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length");
  if ((declared && Number(declared) !== artifact.archiveBytes) || !response.body) {
    await response.body?.cancel();
    throw new Error("Managed Mac runtime archive length is invalid");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(artifact.archiveBytes);
  let offset = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > bytes.length) throw new Error("Managed Mac runtime archive exceeded pinned size");
      bytes.set(part.value, offset);
      offset += part.value.length;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  if (offset !== bytes.length || (await digest(bytes)) !== artifact.archiveSha256) throw new Error("Managed Mac runtime archive integrity check failed");
  return bytes;
};
const unzip = async (args: string[]): Promise<Deno.CommandOutput> => {
  const child = new Deno.Command("/usr/bin/unzip", { args, stdout: "piped", stderr: "piped" }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The exact extraction child already settled.
    }
  }, 30_000);
  try {
    return await child.output();
  } finally {
    clearTimeout(timer);
  }
};
const extractBinary = async (archive: string, artifact: Artifact, run: (args: string[]) => Promise<Deno.CommandOutput>): Promise<Uint8Array> => {
  const decoder = new TextDecoder();
  const names = await run(["-Z", "-1", archive]);
  const details = await run(["-Z", "-l", archive]);
  if (
    !names.success ||
    !details.success ||
    decoder.decode(names.stdout).trim() !== "deno" ||
    !/^-[rwxstST-]{9}\s.*\sdeno$/m.test(decoder.decode(details.stdout))
  ) {
    throw new Error("Managed Mac runtime archive must contain only a regular deno member");
  }
  const result = await run(["-p", archive, "deno"]);
  if (!result.success || result.stdout.length !== artifact.binaryBytes || (await digest(result.stdout)) !== artifact.binarySha256) {
    throw new Error("Managed Mac runtime extracted binary integrity check failed");
  }
  return result.stdout;
};

/** Deployment uses the fixed pin; only isolated fixtures provide test dependencies. */
export const prepareMacRuntime = async (root: string, test: TestDependencies = {}): Promise<string> => {
  if ((test.os ?? Deno.build.os) !== "darwin" || (test.arch ?? Deno.build.arch) !== "aarch64") throw new Error("Managed Mac runtime requires macOS aarch64");
  const artifact = test.artifact ?? MAC_RUNTIME;
  for (const path of [root + "/.data", root + "/.data/runtimes", root + "/.data/runtimes/deno"]) await directory(path);
  const store = root + "/.data/runtimes/deno";
  const destination = store + "/" + artifact.version + "-" + artifact.binarySha256;
  const binary = destination + "/deno";
  const present = await existing(destination);
  if (present) {
    if (!present.isDirectory || present.isSymlink) throw new Error("Managed Mac runtime destination is not a regular directory");
    await verifiedBinary(binary, artifact);
    return binary;
  }
  const staging = await Deno.makeTempDir({ dir: store, prefix: ".staging-" });
  let published = false;
  try {
    const archive = staging + "/archive.zip";
    await Deno.writeFile(archive, await readArchive(await archiveResponse(artifact, test.fetch ?? fetch), artifact));
    await Deno.writeFile(staging + "/deno", await extractBinary(archive, artifact, test.unzip ?? unzip));
    await verifiedBinary(staging + "/deno", artifact);
    await Deno.remove(archive);
    await Deno.chmod(staging + "/deno", 0o500);
    await Deno.chmod(staging, 0o500);
    if (await existing(destination)) throw new Error("Managed Mac runtime destination appeared during preparation");
    await Deno.rename(staging, destination);
    published = true;
    return binary;
  } finally {
    if (!published) {
      await Deno.chmod(staging, 0o700);
      await Deno.remove(staging, { recursive: true });
    }
  }
};
