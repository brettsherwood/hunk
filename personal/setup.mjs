import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_STATE_VERSION = 1;
const RELEASE_MANIFEST_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RELEASE_ID_PATTERN = /^release-[A-Za-z0-9][A-Za-z0-9-]{5,80}$/;
const NAMESPACE_ID_PATTERN = /^wire-[1-9][0-9]*-[a-f0-9-]{6,40}$/;
const DEFAULTS_KEYS = new Set([
  "theme",
  "mode",
  "sidebar",
  "menu_bar",
  "agent_notes",
  "line_numbers",
  "wrap_lines",
  "hunk_headers",
  "copy_decorations",
  "cursor_line",
]);

/** Return the repository checkout containing this module. */
export function resolveRepositoryRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

/** Parse the portable scalar defaults file without bringing in a TOML dependency. */
export function parseDefaultsToml(source) {
  const defaults = Object.create(null);
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Error("Invalid personal default on line " + String(index + 1) + ".");
    const key = match[1];
    if (!DEFAULTS_KEYS.has(key)) {
      throw new Error("Unknown personal default key: " + key + ".");
    }
    if (Object.hasOwn(defaults, key)) {
      throw new Error("Duplicate personal default key: " + key + ".");
    }

    const encodedValue = match[2];
    if (encodedValue === "true" || encodedValue === "false") {
      defaults[key] = encodedValue === "true";
    } else if (encodedValue.startsWith('"') && encodedValue.endsWith('"')) {
      const value = JSON.parse(encodedValue);
      if (typeof value !== "string") {
        throw new Error("Expected a string personal default for " + key + ".");
      }
      defaults[key] = value;
    } else {
      throw new Error("Personal default " + key + " must be a TOML string or boolean.");
    }
  }

  if (Object.keys(defaults).length === 0) {
    throw new Error("The personal defaults file does not contain any settings.");
  }
  return defaults;
}

function readPhysicalLine(source, start) {
  let end = start;
  while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
  let next = end;
  if (source[next] === "\r" && source[next + 1] === "\n") next += 2;
  else if (source[next] === "\r" || source[next] === "\n") next += 1;
  return {
    start,
    contentEnd: end,
    next,
    text: source.slice(start, end),
  };
}

function findTomlStatementEnd(source, start) {
  let squareDepth = 0;
  let braceDepth = 0;
  let quote = null;
  let multiline = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const triple = source.slice(index, index + 3);

    if (quote) {
      const delimiter = multiline ? quote.repeat(3) : quote;
      if (quote === '"' && char === "\\") {
        index += 1;
        continue;
      }
      if (source.slice(index, index + delimiter.length) === delimiter) {
        index += delimiter.length - 1;
        quote = null;
        multiline = false;
      }
      continue;
    }

    if (char === "#") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index += 1;
      }
      if (squareDepth === 0 && braceDepth === 0) return index;
      continue;
    }

    if (char === '"' || char === "'") {
      if (triple === char.repeat(3)) {
        quote = char;
        multiline = true;
        index += 2;
      } else {
        quote = char;
      }
      continue;
    }

    if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (
      (char === "\n" || char === "\r") &&
      !multiline &&
      squareDepth === 0 &&
      braceDepth === 0
    ) {
      return index;
    }
  }

  return source.length;
}

function scanRootAssignments(source) {
  const assignments = [];
  let firstTableStart = null;
  let lastRootAssignment = null;
  let inTable = false;
  let cursor = 0;

  while (cursor < source.length) {
    const line = readPhysicalLine(source, cursor);
    const trimmed = line.text.trimStart().replace(/^\uFEFF/, "");
    if (!trimmed || trimmed.startsWith("#")) {
      cursor = line.next;
      continue;
    }

    if (trimmed.startsWith("[")) {
      inTable = true;
      if (firstTableStart === null) firstTableStart = cursor;
      cursor = line.next;
      continue;
    }

    const match =
      /^(\uFEFF?\s*)((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+))*)(\s*=\s*)/.exec(
        line.text,
      );
    if (!match) {
      cursor = line.next;
      continue;
    }

    let key = "";
    const isSingleKey = /^(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)$/.test(match[2]);
    if (isSingleKey) key = match[2];
    if (key.startsWith('"')) {
      try {
        key = JSON.parse(key);
      } catch {
        key = "";
      }
    } else if (key.startsWith("'")) {
      key = key.slice(1, -1);
    }
    const valueStart = cursor + match[0].length;
    const end = findTomlStatementEnd(source, valueStart);
    const statementLine = readPhysicalLine(source, end);
    const assignment = {
      key,
      start: cursor,
      prefix: match[0],
      valueStart,
      end,
      next: statementLine.next,
    };
    if (!inTable) {
      assignments.push(assignment);
      lastRootAssignment = assignment;
    }
    cursor = statementLine.next;
  }

  return { assignments, firstTableStart, lastRootAssignment };
}

function findInlineComment(value) {
  let quote = null;
  let multiline = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      const delimiter = multiline ? quote.repeat(3) : quote;
      if (quote === '"' && char === "\\") {
        index += 1;
        continue;
      }
      if (value.slice(index, index + delimiter.length) === delimiter) {
        index += delimiter.length - 1;
        quote = null;
        multiline = false;
      }
      continue;
    }
    if (char === "#") return index;
    if (char === '"' || char === "'") {
      if (value.slice(index, index + 3) === char.repeat(3)) {
        quote = char;
        multiline = true;
        index += 2;
      } else {
        quote = char;
      }
    }
  }
  return -1;
}

function encodeTomlScalar(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  throw new Error("Personal defaults may contain only strings and booleans.");
}

/** Merge named root-level preferences while preserving unrelated TOML text. */
export function mergeTopLevelDefaults(source, defaults, policy = "missing") {
  if (!["initialize", "missing", "force"].includes(policy)) {
    throw new Error("Unknown personal config merge policy: " + String(policy) + ".");
  }

  const { assignments } = scanRootAssignments(source);
  const byKey = new Map();
  for (const assignment of assignments) {
    if (!Object.hasOwn(defaults, assignment.key)) continue;
    const matches = byKey.get(assignment.key) ?? [];
    matches.push(assignment);
    byKey.set(assignment.key, matches);
  }
  for (const [key, matches] of byKey) {
    if (matches.length > 1) {
      throw new Error("The user config contains duplicate top-level " + key + " keys.");
    }
  }

  const shouldReplace = policy === "initialize" || policy === "force";
  let updated = source;
  if (shouldReplace && byKey.size > 0) {
    const edits = [];
    for (const [key, matches] of byKey) {
      const assignment = matches[0];
      const statement = source.slice(assignment.start, assignment.end);
      if (statement.includes("\n") || statement.includes("\r")) {
        throw new Error(
          "The existing " +
            key +
            " setting spans multiple TOML lines. " +
            "It was left unchanged; edit that setting to one line and retry.",
        );
      }
      const valueRegion = source.slice(assignment.valueStart, assignment.end);
      const commentAt = findInlineComment(valueRegion);
      const valuePart = commentAt === -1 ? valueRegion : valueRegion.slice(0, commentAt);
      const comment = commentAt === -1 ? "" : valueRegion.slice(commentAt);
      const trailingSpace = valuePart.slice(valuePart.trimEnd().length);
      edits.push({
        start: assignment.start,
        end: assignment.end,
        text: assignment.prefix + encodeTomlScalar(defaults[key]) + trailingSpace + comment,
      });
    }
    edits.sort((left, right) => right.start - left.start);
    for (const edit of edits) {
      updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
    }
  }

  const updatedScan = scanRootAssignments(updated);
  const present = new Set(updatedScan.assignments.map((assignment) => assignment.key));
  const missing = Object.entries(defaults).filter(([key]) => !present.has(key));
  if (missing.length === 0) return { source: updated, changed: updated !== source };

  const insertionPoint = updatedScan.lastRootAssignment
    ? updatedScan.lastRootAssignment.next
    : (updatedScan.firstTableStart ?? updated.length);
  const newline = (updated.match(/\r\n|\n|\r/) ?? ["\n"])[0];
  const settingLines = missing
    .map(([key, value]) => key + " = " + encodeTomlScalar(value))
    .join(newline);
  const left = updated.slice(0, insertionPoint);
  const right = updated.slice(insertionPoint);
  const prefix = left && !left.endsWith("\n") && !left.endsWith("\r") ? newline : "";
  const suffix = right && !right.startsWith("\n") && !right.startsWith("\r") ? newline : "";
  updated = left + prefix + settingLines + newline + right + suffix;
  return { source: updated, changed: updated !== source };
}

/** Quote one POSIX shell argument without evaluating its contents. */
export function quotePosixArgument(value) {
  if (/[\0\r\n]/.test(value)) throw new Error("Launcher paths cannot contain line breaks.");
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Quote one path embedded in a Windows batch file. */
export function quoteWindowsBatchPath(value) {
  if (/["\0\r\n]/.test(value)) {
    throw new Error("Windows launcher paths cannot contain quotes or line breaks.");
  }
  return '"' + value.replace(/%/g, "%%") + '"';
}

/** Render the small user-visible command shim for one install directory. */
export function renderLauncher(platform, launchModulePath) {
  if (platform === "win32") {
    return [
      "@echo off",
      "rem Generated by Hunk personal setup. The source checkout owns the selected release.",
      "node " + quoteWindowsBatchPath(launchModulePath) + " %*",
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "# Generated by Hunk personal setup. The source checkout owns the selected release.",
    "exec node " + quotePosixArgument(launchModulePath) + ' "$@"',
    "",
  ].join("\n");
}

/** Resolve Hunk's user config location without redirecting config or extension discovery. */
export function resolveUserConfigPath(env = process.env, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path;
  let configRoot;
  if (env.XDG_CONFIG_HOME) {
    if (!pathApi.isAbsolute(env.XDG_CONFIG_HOME)) {
      throw new Error("XDG_CONFIG_HOME must be absolute before personal defaults can be applied.");
    }
    configRoot = env.XDG_CONFIG_HOME;
  } else {
    const home = env.HOME || env.USERPROFILE;
    if (!home) return null;
    configRoot = pathApi.join(home, ".config");
  }
  return pathApi.join(configRoot, "hunk", "config.toml");
}

/** Resolve the command shim directory, defaulting to the isolated source checkout install. */
export function resolveInstallDirectory(
  override,
  repoRoot,
  personalRoot,
  platform = process.platform,
) {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (!override) return pathApi.join(personalRoot, "bin");
  return pathApi.isAbsolute(override)
    ? pathApi.normalize(override)
    : pathApi.resolve(repoRoot, override);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid " + label + ".");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Invalid " + label + " fields.");
  }
  return value;
}

/** Reject malformed state and path-like identifiers before using them in filesystem paths. */
export function validateInstallState(value) {
  const state = exactRecord(
    value,
    ["version", "activeRelease", "previousRelease", "configInitialized", "namespaces"],
    "personal install state",
  );
  if (state.version !== INSTALL_STATE_VERSION) {
    throw new Error("Unsupported personal install state version.");
  }
  if (!RELEASE_ID_PATTERN.test(state.activeRelease)) {
    throw new Error("Invalid active release id in personal install state.");
  }
  if (
    state.previousRelease !== null &&
    (!RELEASE_ID_PATTERN.test(state.previousRelease) ||
      state.previousRelease === state.activeRelease)
  ) {
    throw new Error("Invalid previous release id in personal install state.");
  }
  if (typeof state.configInitialized !== "boolean" || !Array.isArray(state.namespaces)) {
    throw new Error("Invalid personal install state values.");
  }
  const namespaceIds = new Set();
  for (const rawNamespace of state.namespaces) {
    const namespace = exactRecord(
      rawNamespace,
      ["id", "daemonVersion", "port"],
      "runtime namespace",
    );
    if (
      typeof namespace.id !== "string" ||
      !NAMESPACE_ID_PATTERN.test(namespace.id) ||
      !isPositiveSafeInteger(namespace.daemonVersion) ||
      !Number.isInteger(namespace.port) ||
      namespace.port < 1 ||
      namespace.port > 65_535 ||
      namespaceIds.has(namespace.id)
    ) {
      throw new Error("Invalid runtime namespace in personal install state.");
    }
    namespaceIds.add(namespace.id);
  }
  if (
    new Set(state.namespaces.map((namespace) => namespace.port)).size !== state.namespaces.length
  ) {
    throw new Error("Personal runtime namespaces must use different loopback ports.");
  }
  return state;
}

/** Keep a wire-compatible namespace when a candidate matches the active release. */
export async function selectRuntimeNamespace({
  namespaces,
  previousDaemonVersion,
  previousNamespaceId,
  candidateDaemonVersion,
  allocatePort,
  makeId = () => randomUUID().replace(/-/g, "").slice(0, 12),
}) {
  if (
    previousDaemonVersion === candidateDaemonVersion &&
    previousDaemonVersion !== null &&
    previousDaemonVersion !== undefined
  ) {
    const prior = namespaces.find(
      (namespace) =>
        namespace.id === previousNamespaceId && namespace.daemonVersion === candidateDaemonVersion,
    );
    if (prior) return { namespace: prior, reused: true };
  }

  const id = "wire-" + String(candidateDaemonVersion) + "-" + makeId();
  if (!NAMESPACE_ID_PATTERN.test(id))
    throw new Error("Could not create a valid runtime namespace id.");
  let port;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    port = await allocatePort();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Could not allocate a valid loopback port for the personal install.");
    }
    if (!namespaces.some((namespace) => namespace.port === port)) break;
    port = undefined;
  }
  if (port === undefined) throw new Error("Could not allocate a distinct loopback port.");
  return {
    namespace: { id, daemonVersion: candidateDaemonVersion, port },
    reused: false,
  };
}

/** Reserve an available loopback port and release it for Hunk to bind on its first session. */
export function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return (
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function makeReleaseId(now = new Date(), random = randomUUID()) {
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return "release-" + timestamp + "-" + random.replace(/-/g, "").slice(0, 8);
}

function makePaths(repoRoot) {
  const personalRoot = path.join(repoRoot, ".personal");
  return {
    repoRoot,
    personalRoot,
    defaultsPath: path.join(repoRoot, "personal", "defaults.toml"),
    statePath: path.join(personalRoot, "install-state.json"),
    toolchainDir: path.join(personalRoot, "toolchain"),
    buildRoot: path.join(personalRoot, "build"),
    releasesRoot: path.join(personalRoot, "releases"),
    runtimeRoot: path.join(personalRoot, "runtime"),
    probesRoot: path.join(personalRoot, "probes"),
    configChecksRoot: path.join(personalRoot, "config-checks"),
  };
}

function ensurePrivateDirectory(fsApi, directory, platform) {
  fsApi.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = fsApi.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Refusing unsafe personal setup directory: " + directory);
  }
  if (platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Personal setup directory is owned by another user: " + directory);
    }
    if ((stat.mode & 0o077) !== 0) fsApi.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  }
}

function ensureDirectory(fsApi, directory) {
  fsApi.mkdirSync(directory, { recursive: true });
  const stat = fsApi.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Refusing to write an install shim into a non-directory path: " + directory);
  }
}

function validatePrivateFile(fsApi, filePath, platform) {
  const stat = fsApi.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Refusing unsafe personal metadata file: " + filePath);
  }
  if (platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("Personal metadata is owned by another user: " + filePath);
    }
    if ((stat.mode & 0o177) !== 0) fsApi.chmodSync(filePath, PRIVATE_FILE_MODE);
  }
}

function atomicWriteFile(fsApi, filePath, content, mode = PRIVATE_FILE_MODE) {
  const temporaryPath = filePath + "." + randomUUID() + ".tmp";
  let descriptor;
  try {
    descriptor = fsApi.openSync(temporaryPath, "wx", mode);
    fsApi.writeFileSync(descriptor, content);
    fsApi.fsyncSync(descriptor);
    fsApi.closeSync(descriptor);
    descriptor = undefined;
    fsApi.renameSync(temporaryPath, filePath);
    if (process.platform !== "win32") fsApi.chmodSync(filePath, mode);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fsApi.closeSync(descriptor);
      } catch {}
    }
    try {
      fsApi.rmSync(temporaryPath, { force: true });
    } catch {}
    throw error;
  }
}

function atomicWriteJson(fsApi, filePath, value) {
  atomicWriteFile(fsApi, filePath, JSON.stringify(value, null, 2) + "\n", PRIVATE_FILE_MODE);
}

function readPrivateJson(fsApi, filePath, platform) {
  validatePrivateFile(fsApi, filePath, platform);
  const stat = fsApi.statSync(filePath);
  if (stat.size <= 0 || stat.size > 64 * 1024) {
    throw new Error("Personal metadata file has an invalid size: " + filePath);
  }
  try {
    return JSON.parse(fsApi.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error("Could not read personal metadata file: " + filePath, { cause: error });
  }
}

function readPackageMetadata(fsApi, repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  const metadata = JSON.parse(fsApi.readFileSync(packagePath, "utf8"));
  const match = /^bun@([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)$/.exec(
    metadata.packageManager ?? "",
  );
  if (!match) throw new Error("package.json must pin Bun with an exact packageManager version.");
  const cliPackagePath = path.join(repoRoot, "packages", "hunk", "package.json");
  const cliMetadata = JSON.parse(fsApi.readFileSync(cliPackagePath, "utf8"));
  if (
    typeof cliMetadata.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(cliMetadata.version)
  ) {
    throw new Error("The Hunk package must declare a valid CLI version.");
  }
  return { cliVersion: cliMetadata.version, bunVersion: match[1] };
}

function packageBunVersion(fsApi, toolchainDir) {
  const packagePath = path.join(toolchainDir, "node_modules", "bun", "package.json");
  if (!fsApi.existsSync(packagePath)) return null;
  try {
    const metadata = JSON.parse(fsApi.readFileSync(packagePath, "utf8"));
    return typeof metadata.version === "string" ? metadata.version : null;
  } catch {
    return null;
  }
}

/** Locate the npm JavaScript CLI so setup does not need a shell on Windows. */
export function resolveNpmInvocation({
  env = process.env,
  platform = process.platform,
  fsApi = fs,
}) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const pathValue = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? ["npm.cmd", "npm.exe", "npm"] : ["npm"];
  for (const entry of pathValue.split(pathApi.delimiter)) {
    if (!entry) continue;
    for (const name of names) {
      const candidate = pathApi.resolve(entry, name);
      if (!fsApi.existsSync(candidate)) continue;
      let resolved = candidate;
      try {
        resolved = fsApi.realpathSync(candidate);
      } catch {}
      if (/\.(?:c?js|mjs)$/i.test(resolved)) {
        return { command: process.execPath, prefixArgs: [resolved] };
      }
      if (platform === "win32") {
        const npmCli = pathApi.join(
          pathApi.dirname(candidate),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        );
        if (fsApi.existsSync(npmCli)) {
          return { command: process.execPath, prefixArgs: [npmCli] };
        }
        try {
          const wrapper = fsApi.readFileSync(candidate, "utf8");
          if (/npm-cli\.js/i.test(wrapper)) {
            const adjacent = path.join(
              path.dirname(candidate),
              "node_modules",
              "npm",
              "bin",
              "npm-cli.js",
            );
            if (fsApi.existsSync(adjacent)) {
              return { command: process.execPath, prefixArgs: [adjacent] };
            }
          }
        } catch {}
      }
    }
  }
  throw new Error("npm was not found on PATH. Install Node.js 22 or newer with npm and retry.");
}

function defaultProcessRunner(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (options.stdio !== "inherit") {
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        if (options.echo) process.stdout.write(text);
      });
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr += text;
        if (options.echo) process.stderr.write(text);
      });
    }

    const installedHandlers = [];
    if (options.forwardSignals) {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        const handler = () => {
          try {
            child.kill(signal);
          } catch {}
        };
        try {
          process.on(signal, handler);
          installedHandlers.push([signal, handler]);
        } catch {}
      }
    }

    child.once("error", (error) => {
      for (const [signal, handler] of installedHandlers) process.off(signal, handler);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      for (const [registeredSignal, handler] of installedHandlers) {
        process.off(registeredSignal, handler);
      }
      resolve({
        exitCode: exitCode ?? 1,
        signal: signal ?? undefined,
        stdout,
        stderr,
      });
    });
  });
}

function requireSuccess(result, label) {
  if (!result || result.exitCode !== 0) {
    const detail = result?.stderr?.trim() || result?.stdout?.trim();
    throw new Error(
      label +
        " failed with exit " +
        String(result?.exitCode ?? "unknown") +
        (detail ? ":\n" + detail : "."),
    );
  }
  return result;
}

function validateReleaseManifest(value, expectedReleaseId) {
  const manifest = exactRecord(
    value,
    [
      "version",
      "releaseId",
      "cliVersion",
      "daemonVersion",
      "namespaceId",
      "platform",
      "arch",
      "createdAt",
    ],
    "release manifest",
  );
  if (
    manifest.version !== RELEASE_MANIFEST_VERSION ||
    manifest.releaseId !== expectedReleaseId ||
    !RELEASE_ID_PATTERN.test(manifest.releaseId) ||
    typeof manifest.cliVersion !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.cliVersion) ||
    !isPositiveSafeInteger(manifest.daemonVersion) ||
    typeof manifest.namespaceId !== "string" ||
    !NAMESPACE_ID_PATTERN.test(manifest.namespaceId) ||
    typeof manifest.platform !== "string" ||
    typeof manifest.arch !== "string" ||
    typeof manifest.createdAt !== "string" ||
    Number.isNaN(Date.parse(manifest.createdAt))
  ) {
    throw new Error("Invalid personal release manifest for " + expectedReleaseId + ".");
  }
  return manifest;
}

function loadReleaseManifest(fsApi, paths, releaseId, platform) {
  if (!RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error("Invalid personal release id.");
  }
  const releaseDir = path.join(paths.releasesRoot, releaseId);
  const dirStat = fsApi.lstatSync(releaseDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error("Personal release directory is missing or unsafe: " + releaseId);
  }
  const manifestPath = path.join(releaseDir, "manifest.json");
  return validateReleaseManifest(readPrivateJson(fsApi, manifestPath, platform), releaseId);
}

function loadInstallState(fsApi, paths, platform) {
  if (!fsApi.existsSync(paths.statePath)) return null;
  const state = validateInstallState(readPrivateJson(fsApi, paths.statePath, platform));
  const active = loadReleaseManifest(fsApi, paths, state.activeRelease, platform);
  if (!state.namespaces.some((namespace) => namespace.id === active.namespaceId)) {
    throw new Error("Active release has no persisted runtime namespace.");
  }
  if (state.previousRelease) {
    const previous = loadReleaseManifest(fsApi, paths, state.previousRelease, platform);
    if (!state.namespaces.some((namespace) => namespace.id === previous.namespaceId)) {
      throw new Error("Previous release has no persisted runtime namespace.");
    }
  }
  return state;
}

function copyAndStageRelease(fsApi, buildDir, paths, releaseId, platform) {
  const stagingDir = path.join(paths.releasesRoot, "." + releaseId + ".staging");
  const releaseDir = path.join(paths.releasesRoot, releaseId);
  if (fsApi.existsSync(stagingDir) || fsApi.existsSync(releaseDir)) {
    throw new Error("Personal release id already exists; no existing release was changed.");
  }
  ensurePrivateDirectory(fsApi, paths.releasesRoot, platform);
  ensurePrivateDirectory(fsApi, stagingDir, platform);
  try {
    const binaryName = platform === "win32" ? "hunk.exe" : "hunk";
    const builtBinary = path.join(buildDir, binaryName);
    const builtSkills = path.join(buildDir, "skills");
    if (!fsApi.existsSync(builtBinary) || !fsApi.statSync(builtBinary).isFile()) {
      throw new Error("The build did not produce " + builtBinary + ".");
    }
    if (!fsApi.existsSync(builtSkills) || !fsApi.statSync(builtSkills).isDirectory()) {
      throw new Error("The build did not stage its bundled skills.");
    }
    fsApi.copyFileSync(builtBinary, path.join(stagingDir, binaryName));
    if (platform !== "win32") fsApi.chmodSync(path.join(stagingDir, binaryName), 0o755);
    const stagedSkillRoot = path.join(stagingDir, "hunkdiff", "skills");
    ensurePrivateDirectory(fsApi, path.dirname(stagedSkillRoot), platform);
    fsApi.cpSync(builtSkills, stagedSkillRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return { stagingDir, releaseDir, binaryName };
  } catch (error) {
    fsApi.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function validateProbeJson(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error("The isolated daemon status probe did not return JSON.", { cause: error });
  }
  if (
    !value ||
    typeof value !== "object" ||
    !value.cli ||
    !isPositiveSafeInteger(value.cli.daemonVersion) ||
    value.running !== false ||
    value.daemon !== null
  ) {
    throw new Error("The isolated daemon status probe returned an unexpected response.");
  }
  return value.cli.daemonVersion;
}

function resolveBunBinary(paths) {
  return path.join(paths.toolchainDir, "node_modules", "bun", "bin", "bun.exe");
}

function ensureNodeVersion(nodeVersion = process.versions.node) {
  const major = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error("Hunk personal setup requires Node.js 22 or newer.");
  }
}

function configBackupPath(fsApi, configPath, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  let candidate = configPath + ".backup-" + stamp;
  let suffix = 1;
  while (fsApi.existsSync(candidate)) {
    candidate = configPath + ".backup-" + stamp + "-" + String(suffix);
    suffix += 1;
  }
  return candidate;
}

async function applyPersonalConfig({
  fsApi,
  paths,
  env,
  platform,
  state,
  skipConfig,
  applyDefaults,
  now,
  log,
  validateToml,
}) {
  if (skipConfig) {
    log("Skipped user config changes.");
    return { configInitialized: true };
  }
  const configPath = resolveUserConfigPath(env, platform);
  if (!configPath) {
    log("No HOME or USERPROFILE is set; user config was left unchanged.");
    return { configInitialized: true };
  }
  const defaults = parseDefaultsToml(fsApi.readFileSync(paths.defaultsPath, "utf8"));
  let configStat = null;
  try {
    configStat = fsApi.lstatSync(configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (configStat?.isSymbolicLink()) {
    throw new Error(
      "The Hunk config is a symlink. Personal setup will not replace it; use --skip-config or manage that file manually.",
    );
  }
  if (configStat && !configStat.isFile()) {
    throw new Error("The Hunk config path is not a regular file: " + configPath);
  }
  const exists = configStat !== null;
  const original = exists ? fsApi.readFileSync(configPath, "utf8") : "";
  const policy =
    applyDefaults || !state?.configInitialized
      ? applyDefaults
        ? "force"
        : "initialize"
      : "missing";
  const merged = mergeTopLevelDefaults(original, defaults, policy);
  ensurePrivateDirectory(fsApi, paths.configChecksRoot, platform);
  const validationPath = path.join(paths.configChecksRoot, randomUUID() + ".toml");
  try {
    fsApi.writeFileSync(validationPath, merged.source, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await validateToml(validationPath);
  } finally {
    fsApi.rmSync(validationPath, { force: true });
  }
  if (!merged.changed) {
    log("User config already has the personal defaults.");
    return { configInitialized: true };
  }

  fsApi.mkdirSync(path.dirname(configPath), { recursive: true });
  if (exists) {
    const backup = configBackupPath(fsApi, configPath, now);
    fsApi.copyFileSync(configPath, backup, fsApi.constants.COPYFILE_EXCL);
    if (platform !== "win32") fsApi.chmodSync(backup, fsApi.statSync(configPath).mode & 0o777);
    log("Backed up user config to " + backup);
  }
  const mode = exists ? fsApi.statSync(configPath).mode & 0o777 : PRIVATE_FILE_MODE;
  atomicWriteFile(fsApi, configPath, merged.source, mode);
  log("Applied personal defaults to " + configPath);
  return { configInitialized: true };
}

function formatStatus(fsApi, paths, state, platform, installDir) {
  if (!state) {
    return [
      "Hunk personal setup has not created an active release.",
      "Run node scripts/setup-personal setup from this checkout.",
    ].join("\n");
  }
  const active = loadReleaseManifest(fsApi, paths, state.activeRelease, platform);
  const previous = state.previousRelease
    ? loadReleaseManifest(fsApi, paths, state.previousRelease, platform)
    : null;
  const namespace = state.namespaces.find((entry) => entry.id === active.namespaceId);
  const binaryName = platform === "win32" ? "hunk.exe" : "hunk";
  const releaseBinary = path.join(paths.releasesRoot, state.activeRelease, binaryName);
  return [
    "Active: " + active.cliVersion + " (daemon wire " + String(active.daemonVersion) + ")",
    "Binary: " + releaseBinary,
    "Loopback: 127.0.0.1:" + String(namespace.port),
    "Previous: " + (previous ? previous.cliVersion + " (" + state.previousRelease + ")" : "none"),
    "Command shim: " + path.join(installDir, platform === "win32" ? "hunk.cmd" : "hunk"),
  ].join("\n");
}

/** Print setup commands without touching the checkout, toolchain, config, or install state. */
export function formatDryRunPlan({ repoRoot, personalRoot, installDir, command = "setup" }) {
  return [
    "Dry run: no files or settings will be changed.",
    "Checkout: " + repoRoot,
    "Command: " + command,
    "Private data: " + personalRoot,
    "Command shim: " + installDir,
    "Next: npm local-prefix Bun bootstrap, frozen Bun install, typecheck, isolated build, candidate verification, and atomic activation.",
  ].join("\n");
}

/** Run the source setup or handle state-only maintenance commands with injectable dependencies. */
export function createPersonalSetup(dependencies = {}) {
  const fsApi = dependencies.fs ?? fs;
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const repoRoot = path.resolve(dependencies.repoRoot ?? resolveRepositoryRoot());
  const paths = makePaths(repoRoot);
  const runProcess = dependencies.runProcess ?? defaultProcessRunner;
  const allocatePort = dependencies.allocatePort ?? reserveLoopbackPort;
  const now = dependencies.now ?? (() => new Date());
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const log = dependencies.log ?? ((message) => process.stdout.write(message + "\n"));

  function readState() {
    return loadInstallState(fsApi, paths, platform);
  }

  async function runCommand(command, args, options = {}) {
    return runProcess(command, args, options);
  }

  async function installOrUpdate(options) {
    ensureNodeVersion(nodeVersion);
    const packageMetadata = readPackageMetadata(fsApi, repoRoot);
    const state = readState();
    const installDir = resolveInstallDirectory(
      options.installDir,
      repoRoot,
      paths.personalRoot,
      platform,
    );
    const launcherPath = path.join(installDir, platform === "win32" ? "hunk.cmd" : "hunk");
    if (fsApi.existsSync(launcherPath)) {
      const current = fsApi.readFileSync(launcherPath, "utf8");
      if (!current.includes("Generated by Hunk personal setup.")) {
        throw new Error(
          "Refusing to replace an existing command at " +
            launcherPath +
            ". Choose a separate --install-dir or move that file first.",
        );
      }
    }

    ensurePrivateDirectory(fsApi, paths.personalRoot, platform);
    for (const directory of [
      paths.toolchainDir,
      paths.buildRoot,
      paths.releasesRoot,
      paths.runtimeRoot,
      paths.probesRoot,
      paths.configChecksRoot,
    ]) {
      ensurePrivateDirectory(fsApi, directory, platform);
    }

    requireSuccess(
      await runCommand("git", ["--version"], { cwd: repoRoot, env, echo: false }),
      "Git prerequisite check",
    );

    const npmInvocation =
      dependencies.npmInvocation ?? resolveNpmInvocation({ env, platform, fsApi });
    let bunBinary = resolveBunBinary(paths);
    const installedBunVersion = packageBunVersion(fsApi, paths.toolchainDir);
    if (installedBunVersion !== packageMetadata.bunVersion || !fsApi.existsSync(bunBinary)) {
      const npmArgs = [
        ...npmInvocation.prefixArgs,
        "install",
        "--prefix",
        paths.toolchainDir,
        "--no-save",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "bun@" + packageMetadata.bunVersion,
      ];
      requireSuccess(
        await runCommand(npmInvocation.command, npmArgs, {
          cwd: repoRoot,
          env,
          echo: true,
        }),
        "Local Bun bootstrap",
      );
    }
    if (packageBunVersion(fsApi, paths.toolchainDir) !== packageMetadata.bunVersion) {
      throw new Error("npm did not install the exact Bun version pinned by package.json.");
    }
    if (!fsApi.existsSync(bunBinary))
      throw new Error("The local Bun executable was not installed.");
    requireSuccess(
      await runCommand(bunBinary, ["--version"], { cwd: repoRoot, env, echo: false }),
      "Local Bun version check",
    );

    const installEnv = { ...env, SKIP_INSTALL_SIMPLE_GIT_HOOKS: "1" };
    requireSuccess(
      await runCommand(bunBinary, ["install", "--frozen-lockfile"], {
        cwd: repoRoot,
        env: installEnv,
        echo: true,
      }),
      "Frozen Bun dependency install",
    );
    requireSuccess(
      await runCommand(bunBinary, ["run", "typecheck"], {
        cwd: repoRoot,
        env: installEnv,
        echo: true,
      }),
      "Typecheck",
    );

    const releaseId = makeReleaseId(now());
    const buildDir = path.join(paths.buildRoot, releaseId);
    if (fsApi.existsSync(buildDir)) throw new Error("A candidate build directory already exists.");
    ensurePrivateDirectory(fsApi, buildDir, platform);
    const buildEnv = { ...installEnv, HUNK_BUILD_DIR: buildDir };
    requireSuccess(
      await runCommand(bunBinary, ["run", "build:bin"], {
        cwd: repoRoot,
        env: buildEnv,
        echo: true,
      }),
      "Hunk binary build",
    );

    const staged = copyAndStageRelease(fsApi, buildDir, paths, releaseId, platform);
    let probeDir;
    let daemonVersion;
    try {
      const probePort = await allocatePort();
      probeDir = path.join(paths.probesRoot, releaseId);
      ensurePrivateDirectory(fsApi, probeDir, platform);
      const probeEnv = { ...env, HUNK_INSTALL_SOURCE: "dev", HUNK_MCP_HOST: "127.0.0.1" };
      delete probeEnv.HUNK_INTERNAL_SESSION_DAEMON_VERSION;
      probeEnv.HUNK_MCP_PORT = String(probePort);
      probeEnv.XDG_RUNTIME_DIR = probeDir;
      const binaryPath = path.join(staged.stagingDir, staged.binaryName);
      verifyCommandOutput(
        await runCommand(binaryPath, ["--version"], {
          cwd: repoRoot,
          env: probeEnv,
          echo: false,
        }),
        packageMetadata.cliVersion,
        "candidate --version",
      );
      const help = requireSuccess(
        await runCommand(binaryPath, ["--help"], {
          cwd: repoRoot,
          env: probeEnv,
          echo: false,
        }),
        "Candidate --help verification",
      ).stdout;
      if (!help.includes("Usage: hunk")) throw new Error("Candidate --help output was incomplete.");

      for (const skillName of ["hunk-review", "hunk-extensions"]) {
        const skillResult = requireSuccess(
          await runCommand(binaryPath, ["skill", "path", skillName], {
            cwd: repoRoot,
            env: probeEnv,
            echo: false,
          }),
          "Candidate bundled skill verification",
        );
        const skillPath = skillResult.stdout.trim();
        const expectedSkillPath = path.join(
          staged.stagingDir,
          "hunkdiff",
          "skills",
          skillName,
          "SKILL.md",
        );
        if (
          !isInsideDirectory(staged.stagingDir, skillPath) ||
          path.resolve(skillPath) !== path.resolve(expectedSkillPath) ||
          !fsApi.existsSync(skillPath)
        ) {
          throw new Error("Candidate did not resolve the staged " + skillName + " skill.");
        }
      }

      const status = requireSuccess(
        await runCommand(binaryPath, ["daemon", "status", "--json"], {
          cwd: repoRoot,
          env: probeEnv,
          echo: false,
        }),
        "Isolated daemon revision probe",
      );
      daemonVersion = validateProbeJson(status.stdout);
    } catch (error) {
      fsApi.rmSync(staged.stagingDir, { recursive: true, force: true });
      throw error;
    } finally {
      if (probeDir) fsApi.rmSync(probeDir, { recursive: true, force: true });
    }

    const previousManifest = state
      ? loadReleaseManifest(fsApi, paths, state.activeRelease, platform)
      : null;
    const namespaces = state ? [...state.namespaces] : [];
    const selected = await selectRuntimeNamespace({
      namespaces,
      previousDaemonVersion: previousManifest?.daemonVersion ?? null,
      previousNamespaceId: previousManifest?.namespaceId ?? null,
      candidateDaemonVersion: daemonVersion,
      allocatePort,
      makeId: dependencies.makeNamespaceId,
    });
    if (!selected.reused) {
      namespaces.push(selected.namespace);
      ensurePrivateDirectory(fsApi, path.join(paths.runtimeRoot, selected.namespace.id), platform);
    }

    const manifest = {
      version: RELEASE_MANIFEST_VERSION,
      releaseId,
      cliVersion: packageMetadata.cliVersion,
      daemonVersion,
      namespaceId: selected.namespace.id,
      platform,
      arch: dependencies.arch ?? process.arch,
      createdAt: now().toISOString(),
    };
    atomicWriteJson(fsApi, path.join(staged.stagingDir, "manifest.json"), manifest);
    fsApi.renameSync(staged.stagingDir, staged.releaseDir);

    const configResult = await applyPersonalConfig({
      fsApi,
      paths,
      env,
      platform,
      state,
      skipConfig: options.skipConfig,
      applyDefaults: options.applyDefaults,
      now: now(),
      log,
      validateToml: async (validationPath) =>
        requireSuccess(
          await runCommand(
            bunBinary,
            ["-e", "Bun.TOML.parse(await Bun.file(process.argv[1]).text())", validationPath],
            { cwd: repoRoot, env: installEnv, echo: false },
          ),
          "Merged Hunk config TOML validation",
        ),
    });

    ensureDirectory(fsApi, installDir);
    const launchModulePath = path.join(repoRoot, "personal", "launch.mjs");
    atomicWriteFile(
      fsApi,
      launcherPath,
      renderLauncher(platform, launchModulePath),
      platform === "win32" ? 0o600 : 0o755,
    );

    const nextState = {
      version: INSTALL_STATE_VERSION,
      activeRelease: releaseId,
      previousRelease: state?.activeRelease ?? null,
      configInitialized: configResult.configInitialized,
      namespaces,
    };
    atomicWriteJson(fsApi, paths.statePath, nextState);
    log(
      "Activated Hunk " +
        packageMetadata.cliVersion +
        " with daemon wire " +
        String(daemonVersion) +
        ".",
    );
    log("Run " + launcherPath + " --version to check the personal command.");
    return nextState;
  }

  function rollback() {
    const state = readState();
    if (!state?.previousRelease) {
      throw new Error("There is no previous personal release to restore.");
    }
    loadReleaseManifest(fsApi, paths, state.previousRelease, platform);
    const nextState = {
      ...state,
      activeRelease: state.previousRelease,
      previousRelease: state.activeRelease,
    };
    atomicWriteJson(fsApi, paths.statePath, nextState);
    const active = loadReleaseManifest(fsApi, paths, nextState.activeRelease, platform);
    log("Restored Hunk " + active.cliVersion + " (" + nextState.activeRelease + ").");
    return nextState;
  }

  async function launchInstalledHunk(args) {
    const state = readState();
    if (!state) throw new Error("No active personal release exists. Run setup first.");
    const manifest = loadReleaseManifest(fsApi, paths, state.activeRelease, platform);
    const namespace = state.namespaces.find((entry) => entry.id === manifest.namespaceId);
    if (!namespace) throw new Error("Active release has no runtime namespace.");
    const binaryName = platform === "win32" ? "hunk.exe" : "hunk";
    const binaryPath = path.join(paths.releasesRoot, state.activeRelease, binaryName);
    const binaryStat = fsApi.lstatSync(binaryPath);
    if (binaryStat.isSymbolicLink() || !binaryStat.isFile()) {
      throw new Error("Active Hunk binary is missing or unsafe.");
    }
    const runtimeDir = path.join(paths.runtimeRoot, namespace.id);
    ensurePrivateDirectory(fsApi, runtimeDir, platform);
    const launchEnv = { ...env };
    delete launchEnv.HUNK_INTERNAL_SESSION_DAEMON_VERSION;
    Object.assign(launchEnv, {
      HUNK_INSTALL_SOURCE: "dev",
      XDG_RUNTIME_DIR: runtimeDir,
      HUNK_MCP_HOST: "127.0.0.1",
      HUNK_MCP_PORT: String(namespace.port),
    });
    const result = await runCommand(binaryPath, args, {
      cwd,
      env: launchEnv,
      stdio: "inherit",
      forwardSignals: true,
    });
    return result.exitCode;
  }

  async function run(argv = process.argv.slice(2)) {
    const options = parsePersonalSetupArgs(argv);
    const installDir = resolveInstallDirectory(
      options.installDir,
      repoRoot,
      paths.personalRoot,
      platform,
    );
    if (options.command === "help") {
      log(PERSONAL_SETUP_HELP);
      return 0;
    }
    if (options.dryRun) {
      log(
        formatDryRunPlan({
          repoRoot,
          personalRoot: paths.personalRoot,
          installDir,
          command: options.command,
        }),
      );
      return 0;
    }
    if (options.command === "status") {
      log(formatStatus(fsApi, paths, readState(), platform, installDir));
      return 0;
    }
    if (options.command === "rollback") {
      rollback();
      return 0;
    }
    await installOrUpdate(options);
    return 0;
  }

  return { run, rollback, launchInstalledHunk, readState, installOrUpdate };
}

export const PERSONAL_SETUP_HELP = [
  "Hunk personal source setup",
  "",
  "Usage: node scripts/setup-personal [setup|update|rollback|status] [options]",
  "",
  "  setup                 build and activate this checkout",
  "  update                rebuild and activate the current checkout",
  "  rollback              switch to the previous verified release",
  "  status                show the active and previous releases",
  "",
  "Options:",
  "  --dry-run             print the plan without changing files",
  "  --skip-config         leave the user Hunk config unchanged",
  "  --apply-defaults      reapply the named personal config defaults",
  "  --install-dir <path>  write the command shim to this directory",
].join("\n");

/** Parse the portable Node command without shell-dependent option handling. */
export function parsePersonalSetupArgs(argv) {
  const args = [...argv];
  let command = "setup";
  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }
  if (command === "install") command = "setup";
  if (command === "rebuild") command = "update";
  if (!["setup", "update", "rollback", "status", "help"].includes(command)) {
    throw new Error("Unknown personal setup command: " + String(command) + ".");
  }

  const options = {
    command,
    dryRun: false,
    skipConfig: false,
    applyDefaults: false,
    installDir: null,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-config") options.skipConfig = true;
    else if (arg === "--apply-defaults") options.applyDefaults = true;
    else if (arg === "--install-dir") {
      if (!args[0] || args[0].startsWith("--")) {
        throw new Error("--install-dir needs a path.");
      }
      options.installDir = args.shift();
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    } else {
      throw new Error("Unknown personal setup option: " + String(arg) + ".");
    }
  }
  return options;
}

function verifyCommandOutput(result, expected, label) {
  const output = requireSuccess(result, label).stdout.trim();
  if (output !== expected) {
    throw new Error(label + " returned " + JSON.stringify(output) + ", expected " + expected + ".");
  }
}

/** Resolve the active release from install state and run it with this install's private daemon namespace. */
export async function launchInstalledHunk(args = process.argv.slice(2), dependencies = {}) {
  return createPersonalSetup(dependencies).launchInstalledHunk(args);
}

/** Execute setup, update, rollback, or status using the real Node environment. */
export async function runPersonalSetup(argv = process.argv.slice(2), dependencies = {}) {
  return createPersonalSetup(dependencies).run(argv);
}
