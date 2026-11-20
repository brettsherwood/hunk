import { launchInstalledHunk } from "./setup.mjs";

try {
  const exitCode = await launchInstalledHunk(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(
    "Hunk personal launcher: " + (error instanceof Error ? error.message : String(error)) + "\n",
  );
  process.exitCode = 1;
}
