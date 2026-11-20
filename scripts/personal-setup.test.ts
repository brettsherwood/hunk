import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore personal/setup.mjs is the Node entry point shared by the installer and launcher.
import * as personalSetup from "../personal/setup.mjs";

const {
  createPersonalSetup,
  mergeTopLevelDefaults,
  parsePersonalSetupArgs,
  quotePosixArgument,
  quoteWindowsBatchPath,
  renderLauncher,
  resolveInstallDirectory,
  selectRuntimeNamespace,
  validateInstallState,
} = personalSetup;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createFakeCheckout(platform = process.platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hunk personal setup "));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, "personal"), { recursive: true });
  fs.copyFileSync(
    new URL("../personal/defaults.toml", import.meta.url),
    path.join(root, "personal", "defaults.toml"),
  );
  fs.copyFileSync(
    new URL("../personal/launch.mjs", import.meta.url),
    path.join(root, "personal", "launch.mjs"),
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: "bun@1.4.2" }),
  );
  fs.mkdirSync(path.join(root, "packages", "hunk"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "packages", "hunk", "package.json"),
    JSON.stringify({ version: "0.23.0" }),
  );
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const configRoot = path.join(home, "config root");

  const ports = [49101, 49102, 49103, 49104, 49105, 49106];
  let portIndex = 0;
  let buildFails = false;
  let candidateVerificationFails = false;
  let daemonVersion = 18;
  let clock = 0;
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const processRunner = async (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ command, args, env: options.env });
    if (command === "git") return { exitCode: 0, stdout: "git version 2.0.0\n", stderr: "" };
    if (command === "npm") {
      const toolchain = path.join(root, ".personal", "toolchain", "node_modules", "bun");
      fs.mkdirSync(path.join(toolchain, "bin"), { recursive: true });
      fs.writeFileSync(path.join(toolchain, "package.json"), JSON.stringify({ version: "1.4.2" }));
      fs.writeFileSync(path.join(toolchain, "bin", "bun.exe"), "fake-bun");
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "--version" && command.endsWith("bun.exe")) {
      return { exitCode: 0, stdout: "1.4.2\n", stderr: "" };
    }
    if (args[0] === "-e") {
      Bun.TOML.parse(fs.readFileSync(args[2]!, "utf8"));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "install" && args[1] === "--frozen-lockfile") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "run" && args[1] === "typecheck") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "run" && args[1] === "build:bin") {
      if (buildFails) return { exitCode: 1, stdout: "", stderr: "simulated build failure" };
      const output = options.env?.HUNK_BUILD_DIR;
      if (!output) throw new Error("Expected the private HUNK_BUILD_DIR override.");
      fs.mkdirSync(path.join(output, "skills", "hunk-review"), { recursive: true });
      fs.mkdirSync(path.join(output, "skills", "hunk-extensions"), { recursive: true });
      fs.writeFileSync(path.join(output, platform === "win32" ? "hunk.exe" : "hunk"), "fake-hunk");
      fs.writeFileSync(path.join(output, "skills", "hunk-review", "SKILL.md"), "review skill");
      fs.writeFileSync(
        path.join(output, "skills", "hunk-extensions", "SKILL.md"),
        "extensions skill",
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (args[0] === "--version") {
      return { exitCode: 0, stdout: "0.23.0\n", stderr: "" };
    }
    if (args[0] === "--help") {
      if (candidateVerificationFails) {
        return { exitCode: 1, stdout: "", stderr: "simulated candidate help failure" };
      }
      return { exitCode: 0, stdout: "Usage: hunk <command>\n", stderr: "" };
    }
    if (args[0] === "skill" && args[1] === "path") {
      return {
        exitCode: 0,
        stdout: path.join(path.dirname(command), "hunkdiff", "skills", args[2]!, "SKILL.md") + "\n",
        stderr: "",
      };
    }
    if (args[0] === "daemon" && args[1] === "status") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          cli: { daemonVersion, appVersion: "0.23.0" },
          daemon: null,
          running: false,
        }),
        stderr: "",
      };
    }
    throw new Error("Unexpected process: " + command + " " + args.join(" "));
  };

  const setup = createPersonalSetup({
    platform,
    fs,
    repoRoot: root,
    cwd: root,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: configRoot,
      HUNK_INTERNAL_SESSION_DAEMON_VERSION: "999",
    },
    nodeVersion: "22.0.0",
    npmInvocation: { command: "npm", prefixArgs: [] },
    runProcess: processRunner,
    allocatePort: async () => ports[portIndex++]!,
    makeNamespaceId: () => "abcdef123456",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
    log: () => {},
  });

  return {
    root,
    home,
    configRoot,
    setup,
    calls,
    setBuildFails(value: boolean) {
      buildFails = value;
    },
    setCandidateVerificationFails(value: boolean) {
      candidateVerificationFails = value;
    },
    setDaemonVersion(value: number) {
      daemonVersion = value;
    },
  };
}

describe("personal config defaults", () => {
  const defaults = {
    theme: "gruvbox-dark-hard",
    mode: "smart",
    sidebar: true,
  };

  test("initial setup changes only named root settings and preserves comments and tables", () => {
    const original = [
      "# personal note",
      'theme = "tokyo-night" # keep this comment',
      "unrelated = 7",
      "",
      "# extension settings",
      "[extension.example]",
      "enabled = true",
      "",
    ].join("\n");

    const result = mergeTopLevelDefaults(original, defaults, "initialize");

    expect(result.changed).toBe(true);
    expect(result.source).toContain("# personal note");
    expect(result.source).toContain('theme = "gruvbox-dark-hard" # keep this comment');
    expect(result.source).toContain("unrelated = 7");
    expect(result.source).toContain("# extension settings\n[extension.example]\nenabled = true");
    expect(result.source.indexOf('mode = "smart"')).toBeLessThan(
      result.source.indexOf("[extension.example]"),
    );
  });

  test("later updates fill absent defaults and preserve explicit values", () => {
    const original = ['theme = "rose-pine"', "", "[extension.example]", "enabled = true"].join(
      "\n",
    );
    const result = mergeTopLevelDefaults(original, defaults, "missing");

    expect(result.source).toContain('theme = "rose-pine"');
    expect(result.source).toContain('mode = "smart"');
    expect(result.source).toContain("sidebar = true");
    expect(result.source.indexOf("sidebar = true")).toBeLessThan(
      result.source.indexOf("[extension.example]"),
    );
  });

  test("explicit reapply replaces values while retaining inline comments", () => {
    const original = ['theme = "custom" # chosen by me', 'mode = "split"'].join("\n");
    const result = mergeTopLevelDefaults(original, defaults, "force");

    expect(result.source).toContain('theme = "gruvbox-dark-hard" # chosen by me');
    expect(result.source).toContain('mode = "smart"');
  });

  test("recognizes escaped and literal quoted root keys before adding defaults", () => {
    const original = [
      '"th\\u0065me" = "rose-pine"',
      "'mode' = 'split'",
      'note = """',
      "[not.a.table]",
      '"""',
      '["custom_table"]',
      "value = true",
    ].join("\n");
    const result = mergeTopLevelDefaults(original, defaults, "missing");

    expect(result.source).toContain('"th\\u0065me" = "rose-pine"');
    expect(result.source).toContain("'mode' = 'split'");
    expect(result.source.match(/^theme\s*=/gm)).toBeNull();
    expect(result.source.match(/^mode\s*=/gm)).toBeNull();
    expect(result.source).toContain('["custom_table"]\nvalue = true');
    expect(() => Bun.TOML.parse(result.source)).not.toThrow();
  });

  test("keeps table-like text inside a dotted-key multiline value", () => {
    const original = [
      'note.text = """',
      "[not.a.table]",
      '"""',
      "",
      "[extension.example]",
      "enabled = true",
    ].join("\n");
    type Config = {
      note: { text: string };
      theme: string;
      mode: string;
      sidebar: boolean;
      extension: { example: { enabled: boolean } };
    };
    const before = Bun.TOML.parse(original) as Config;
    const result = mergeTopLevelDefaults(original, defaults, "missing");
    const after = Bun.TOML.parse(result.source) as Config;

    expect(after.note.text).toBe(before.note.text);
    expect(after.theme).toBe(defaults.theme);
    expect(after.mode).toBe(defaults.mode);
    expect(after.sidebar).toBe(true);
    expect(after.extension.example.enabled).toBe(true);
  });

  test("reapplies defaults to a quoted root key without losing its spelling", () => {
    const original = ['"theme" = "custom"', "[custom_table]", "mode = 3"].join("\n");
    const result = mergeTopLevelDefaults(original, defaults, "force");

    expect(result.source).toContain('"theme" = "gruvbox-dark-hard"');
    expect(result.source).toContain("[custom_table]\nmode = 3");
    expect(() => Bun.TOML.parse(result.source)).not.toThrow();
  });

  test("does not rewrite a multiline value that needs a manual edit", () => {
    const original = ["theme = [", '  "custom"', "]"].join("\n");
    expect(() => mergeTopLevelDefaults(original, defaults, "force")).toThrow(
      /spans multiple TOML lines/,
    );
    expect(original).toBe(["theme = [", '  "custom"', "]"].join("\n"));
  });
});

describe("personal runtime namespaces", () => {
  test("reuses the active namespace when the daemon wire revision is unchanged", async () => {
    const prior = { id: "wire-18-abcdef123456", daemonVersion: 18, port: 49101 };
    const selected = await selectRuntimeNamespace({
      namespaces: [prior],
      previousDaemonVersion: 18,
      previousNamespaceId: prior.id,
      candidateDaemonVersion: 18,
      allocatePort: async () => 49102,
    });

    expect(selected).toEqual({ namespace: prior, reused: true });
  });

  test("allocates a new namespace when the daemon wire revision changes", async () => {
    const prior = { id: "wire-18-abcdef123456", daemonVersion: 18, port: 49101 };
    const selected = await selectRuntimeNamespace({
      namespaces: [prior],
      previousDaemonVersion: 18,
      previousNamespaceId: prior.id,
      candidateDaemonVersion: 19,
      allocatePort: async () => 49102,
      makeId: () => "fedcba654321",
    });

    expect(selected).toEqual({
      namespace: { id: "wire-19-fedcba654321", daemonVersion: 19, port: 49102 },
      reused: false,
    });
  });

  test("chooses a different port when the allocator returns a stored namespace port", async () => {
    const prior = { id: "wire-18-abcdef123456", daemonVersion: 18, port: 49101 };
    const allocated = [49101, 49102];
    const selected = await selectRuntimeNamespace({
      namespaces: [prior],
      previousDaemonVersion: 18,
      previousNamespaceId: prior.id,
      candidateDaemonVersion: 19,
      allocatePort: async () => allocated.shift()!,
      makeId: () => "fedcba654321",
    });

    expect(selected.namespace.port).toBe(49102);
  });
});

describe("personal setup lifecycle", () => {
  test("repeated setup preserves user edits and activates rollback-ready releases", async () => {
    const fixture = createFakeCheckout();
    const configPath = path.join(fixture.configRoot, "hunk", "config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      ["# keep", 'theme = "old-theme" # inline', "[custom_theme]", 'id = "user"'].join("\n"),
    );

    await fixture.setup.installOrUpdate(parsePersonalSetupArgs(["setup"]));
    const firstState = fixture.setup.readState();
    expect(firstState).not.toBeNull();
    expect(fs.readFileSync(configPath, "utf8")).toContain('theme = "gruvbox-dark-hard" # inline');
    expect(fs.readdirSync(path.dirname(configPath)).some((name) => name.includes(".backup-"))).toBe(
      true,
    );

    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace('theme = "gruvbox-dark-hard"', 'theme = "user-choice"'),
    );
    await fixture.setup.installOrUpdate(parsePersonalSetupArgs(["update"]));
    const secondState = fixture.setup.readState();
    expect(secondState?.activeRelease).not.toBe(firstState?.activeRelease);
    expect(secondState?.previousRelease).toBe(firstState?.activeRelease);
    expect(secondState?.namespaces).toHaveLength(1);
    expect(secondState?.namespaces[0]?.port).toBe(firstState?.namespaces[0]?.port);
    expect(fs.readFileSync(configPath, "utf8")).toContain('theme = "user-choice"');

    fixture.setup.rollback();
    expect(fixture.setup.readState()?.activeRelease).toBe(firstState?.activeRelease);
  });

  test("a failed build leaves the active release unchanged", async () => {
    const fixture = createFakeCheckout();
    await fixture.setup.installOrUpdate(parsePersonalSetupArgs(["setup"]));
    const original = fixture.setup.readState();
    fixture.setBuildFails(true);

    await expect(fixture.setup.installOrUpdate(parsePersonalSetupArgs(["update"]))).rejects.toThrow(
      /simulated build failure/,
    );
    expect(fixture.setup.readState()).toEqual(original);
  });

  test("a failed candidate check leaves the active release unchanged", async () => {
    const fixture = createFakeCheckout();
    await fixture.setup.installOrUpdate(parsePersonalSetupArgs(["setup"]));
    const original = fixture.setup.readState();
    fixture.setCandidateVerificationFails(true);

    await expect(fixture.setup.installOrUpdate(parsePersonalSetupArgs(["update"]))).rejects.toThrow(
      /simulated candidate help failure/,
    );
    expect(fixture.setup.readState()).toEqual(original);
  });

  test("refuses to replace a symlinked user config", async () => {
    if (process.platform === "win32") return;
    const fixture = createFakeCheckout();
    const configPath = path.join(fixture.configRoot, "hunk", "config.toml");
    const targetPath = path.join(fixture.home, "managed-config.toml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(targetPath, 'theme = "managed-elsewhere"\n');
    fs.symlinkSync(targetPath, configPath);

    await expect(fixture.setup.installOrUpdate(parsePersonalSetupArgs(["setup"]))).rejects.toThrow(
      /config is a symlink/,
    );
    expect(fs.readlinkSync(configPath)).toBe(targetPath);
    expect(fs.readFileSync(targetPath, "utf8")).toBe('theme = "managed-elsewhere"\n');
    expect(fixture.setup.readState()).toBeNull();
  });

  test("launches the active binary with its private daemon namespace and unchanged config home", async () => {
    const fixture = createFakeCheckout();
    await fixture.setup.installOrUpdate(parsePersonalSetupArgs(["setup"]));
    const state = fixture.setup.readState();
    await fixture.setup.launchInstalledHunk(["--version"]);
    const launch = fixture.calls.at(-1)!;
    const namespace = state!.namespaces[0]!;

    expect(launch.command).toContain(path.join(".personal", "releases", state!.activeRelease));
    expect(launch.env?.HUNK_INSTALL_SOURCE).toBe("dev");
    expect(launch.env?.XDG_RUNTIME_DIR).toBe(
      path.join(fixture.root, ".personal", "runtime", namespace.id),
    );
    expect(launch.env?.HUNK_MCP_HOST).toBe("127.0.0.1");
    expect(launch.env?.HUNK_MCP_PORT).toBe(String(namespace.port));
    expect(launch.env?.XDG_CONFIG_HOME).toBe(fixture.configRoot);
    expect(launch.env?.HUNK_INTERNAL_SESSION_DAEMON_VERSION).toBeUndefined();
    if (process.platform !== "win32") {
      expect(fs.statSync(launch.env!.XDG_RUNTIME_DIR!).mode & 0o777).toBe(0o700);
      expect(
        fs.statSync(path.join(fixture.root, ".personal", "install-state.json")).mode & 0o777,
      ).toBe(0o600);
    }
  });

  test("a wire change receives a fresh runtime namespace", async () => {
    const fixture = createFakeCheckout();
    await fixture.setup.installOrUpdate(parsePersonalSetupArgs(["setup"]));
    const original = fixture.setup.readState();
    fixture.setDaemonVersion(19);
    await fixture.setup.installOrUpdate(parsePersonalSetupArgs(["update"]));
    const updated = fixture.setup.readState();

    expect(updated?.namespaces).toHaveLength(2);
    expect(updated?.namespaces[0]?.id).not.toBe(updated?.namespaces[1]?.id);
    expect(updated?.namespaces[0]?.port).not.toBe(updated?.namespaces[1]?.port);
    expect(updated?.activeRelease).not.toBe(original?.activeRelease);
  });
});

describe("personal setup path and state safety", () => {
  test("rejects traversal and unexpected fields in install state", () => {
    const state = {
      version: 1,
      activeRelease: "release-abcdef",
      previousRelease: null,
      configInitialized: true,
      namespaces: [{ id: "wire-18-abcdef", daemonVersion: 18, port: 49101 }],
    };
    expect(validateInstallState(state)).toEqual(state);
    expect(() => validateInstallState({ ...state, activeRelease: "../outside" })).toThrow(
      /release id/,
    );
    expect(() => validateInstallState({ ...state, releasePath: "../../outside" })).toThrow(
      /fields/,
    );
    expect(() =>
      validateInstallState({
        ...state,
        namespaces: [...state.namespaces, { id: "wire-19-fedcba", daemonVersion: 19, port: 49101 }],
      }),
    ).toThrow(/different loopback ports/);
  });

  test("quotes POSIX and Windows paths and resolves platform-specific shim directories", () => {
    expect(quotePosixArgument("/tmp/a'b")).toBe("'/tmp/a'\\''b'");
    expect(quoteWindowsBatchPath("C:\\Users\\A B\\100%")).toBe('"C:\\Users\\A B\\100%%"');
    expect(renderLauncher("win32", "C:\\Users\\A B\\hunk\\personal\\launch.mjs")).toContain(
      'node "C:\\Users\\A B\\hunk\\personal\\launch.mjs" %*',
    );
    expect(
      resolveInstallDirectory(
        "..\\custom bin",
        "C:\\Users\\A B\\hunk",
        "C:\\Users\\A B\\hunk\\.personal",
        "win32",
      ),
    ).toBe("C:\\Users\\A B\\custom bin");
    expect(resolveInstallDirectory(null, "/repo", "/repo/.personal", "linux")).toBe(
      "/repo/.personal/bin",
    );
  });

  test("parses setup, update, rollback, and explicit config choices", () => {
    expect(parsePersonalSetupArgs(["setup", "--dry-run", "--skip-config"])).toMatchObject({
      command: "setup",
      dryRun: true,
      skipConfig: true,
    });
    expect(parsePersonalSetupArgs(["rebuild", "--apply-defaults"])).toMatchObject({
      command: "update",
      applyDefaults: true,
    });
    expect(parsePersonalSetupArgs(["rollback"])).toMatchObject({ command: "rollback" });
    expect(parsePersonalSetupArgs(["status", "--install-dir", "private bin"])).toMatchObject({
      command: "status",
      installDir: "private bin",
    });
  });
});
