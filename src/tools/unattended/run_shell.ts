import { spawn } from "node:child_process";
import { defineTool } from "../../registry.ts";

export const RUN_SHELL_TIMEOUT_MS = 120_000;
export const RUN_SHELL_MAX_OUTPUT_BYTES = 100_000;

/**
 * Runs a shell command and returns its combined stdout/stderr and exit status. Unlike the other
 * tools, this runs programs with the harness's full permissions, so it is only ever registered in
 * unattended mode (see src/agent_tools.ts), which is meant to run inside an isolated sandbox.
 */
export function createRunShellTool(cwd: string, opts: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const timeoutMs = opts.timeoutMs ?? RUN_SHELL_TIMEOUT_MS;
  const maxBytes = opts.maxOutputBytes ?? RUN_SHELL_MAX_OUTPUT_BYTES;
  return defineTool({
    name: "run_shell",
    description:
      'Run a shell command with "/bin/sh -c" in the workspace directory and return its combined stdout and stderr and its exit status. ' +
      "Use it to build, run and inspect programs. The command runs with the harness's full permissions in this environment, which is intended to be an isolated sandbox. " +
      `Output over ${Math.round(maxBytes / 1000)} KB is truncated, and a command still running after ${timeoutMs / 1000} s is killed.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: 'The shell command to run, e.g. "gcc -o x x.c && ./x < input"' },
      },
      required: ["command"],
    },
    handler: (input, { signal }) => {
      const command = input.command as string;
      return new Promise<string>((resolveOut) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const child = spawn("/bin/sh", ["-c", command], { cwd, signal });
        const onData = (buf: Buffer) => {
          if (truncated) return;
          chunks.push(buf);
          size += buf.length;
          if (size >= maxBytes) truncated = true;
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        const finish = (status: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const out = Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
          const notes = [status];
          if (truncated) notes.push(`output truncated at ${Math.round(maxBytes / 1000)} KB`);
          resolveOut(`[${notes.join("; ")}]\n${out}`.trimEnd());
        };
        child.on("error", (err) => {
          if (signal.aborted) return finish("interrupted by the user before the command started");
          finish(`the command could not be started: ${(err as Error).message}`);
        });
        child.on("close", (code, sig) => {
          if (timedOut) return finish(`no exit: killed after the ${timeoutMs / 1000} s timeout`);
          if (signal.aborted) return finish("interrupted by the user");
          if (sig) return finish(`terminated by signal ${sig}`);
          finish(`exit code ${code ?? 0}`);
        });
      });
    },
  });
}
