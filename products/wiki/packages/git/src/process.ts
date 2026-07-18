import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openWikiGitArgs, openWikiGitEnv } from "@openwiki/core";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export function gitArgs(root: string, args: string[]): string[] {
  return openWikiGitArgs(root, args);
}

function gitEnv(): NodeJS.ProcessEnv {
  return openWikiGitEnv();
}

export async function gitWithOutput(root: string, args: string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", gitArgs(root, args), {
    env: { ...gitEnv(), ...options.env },
    timeout: options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
  return { stdout, stderr };
}

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await gitWithOutput(root, args);
  return stdout;
}

export async function gitOptional(root: string, args: string[]): Promise<string | undefined> {
  try {
    const value = (await git(root, args)).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}
