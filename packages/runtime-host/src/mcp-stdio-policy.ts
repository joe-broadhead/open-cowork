import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { CustomMcpConfig } from '@open-cowork/shared'

const ALLOWED_BARE_COMMANDS = new Set([
  'node',
  'npx',
  'npm',
  'pnpm',
  'bun',
  'bunx',
  'python',
  'python3',
  'uv',
  'uvx',
  'deno',
  'go',
  'ruby',
  'java',
])

// Package installers that can fetch remote code. Require a version/tag pin
// (JOE-827) so floating latest installs are not the default trust model.
const PACKAGE_RUNNERS = new Set(['npx', 'npm', 'pnpm', 'bunx', 'uvx', 'deno'])


function hasPathSeparator(value: string) {
  return value.includes('/') || value.includes('\\')
}

function existingFile(path: string) {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveProjectRelativePath(command: string, directory?: string | null) {
  if (!directory) return null
  const root = resolve(directory)
  const candidate = resolve(root, command)
  const relativeToRoot = relative(root, candidate)
  if (relativeToRoot === '') return candidate
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) return null
  try {
    const realRoot = realpathSync.native(root)
    const realCandidate = realpathSync.native(candidate)
    const relativeToRealRoot = relative(realRoot, realCandidate)
    if (relativeToRealRoot === '' || relativeToRealRoot.startsWith('..') || isAbsolute(relativeToRealRoot)) {
      return null
    }
    return realCandidate
  } catch {
    return candidate
  }
}

// Shells that can eval arbitrary code via `-c`. Listed explicitly so a
// user can't sneak past by writing `/bin/sh` or `/usr/local/bin/bash`:
// the validator checks the trailing path segment too.
const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh', 'powershell'])

// Flags that instruct the allowed runtimes to evaluate a script passed
// via argv instead of reading a file. Blocking these defuses the
// `node -e "malicious"` / `python -c "malicious"` / `ruby -e` / `bun -e`
// style RCE against the allowlist — legitimate MCPs reference a
// package (via npx) or a script file, never an inline expression.
const SCRIPT_EVAL_FLAGS = new Set([
  '-c',          // python, ruby, sh
  '--command',   // some shells
  '-e',          // node, ruby, perl, bun
  '--eval',      // node, deno
  '--eval-file', // deno (loads arbitrary files)
  '-E',          // perl (extended eval)
  '-p',          // perl (one-liner print mode — enables code eval)
  '-pe',         // perl shorthand
  '-ne',         // perl shorthand
  '--execute',   // some custom runtimes
])

const SCRIPT_EVAL_LONG_FLAGS_WITH_VALUE = new Set([
  '--command',
  '--eval',
  '--eval-file',
  '--execute',
])

const SCRIPT_EVAL_SHORT_FLAGS_WITH_VALUE = [
  '-c',
  '-e',
  '-E',
  '-p',
  '-pe',
  '-ne',
]

function isScriptEvalArgument(arg: string) {
  if (SCRIPT_EVAL_FLAGS.has(arg)) return true
  for (const flag of SCRIPT_EVAL_LONG_FLAGS_WITH_VALUE) {
    if (arg.startsWith(`${flag}=`)) return true
  }
  return SCRIPT_EVAL_SHORT_FLAGS_WITH_VALUE.some((flag) => (
    arg.startsWith(flag) && arg.length > flag.length
  ))
}

// Patterns that only ever appear inside shell-style command strings.
// We reject them in individual argv entries because the user sometimes
// pastes a full command line into the single "Command" field and we
// want to fail clearly rather than silently invoke a shell.
const SHELL_METACHARS = /[;&|`$><]|\$\(|&&|\|\||<\(|>\(/

function basename(path: string) {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1]!
}

function looksPinnedPackageSpec(spec: string) {
  // Accept name@version, @scope/name@version, path/to.tgz, git+..., and
  // explicit file: refs. Reject bare names and name@latest / name@* floaters.
  const trimmed = spec.trim()
  if (!trimmed || trimmed.startsWith('-')) return false
  if (trimmed === 'latest' || trimmed === '*' || trimmed.endsWith('@latest') || trimmed.endsWith('@*')) return false
  if (trimmed.includes('@') && !trimmed.startsWith('@')) {
    const at = trimmed.lastIndexOf('@')
    const version = trimmed.slice(at + 1)
    return Boolean(version) && version !== 'latest' && version !== '*'
  }
  if (trimmed.startsWith('@')) {
    // @scope/name@version — need a second @ for version
    const rest = trimmed.slice(1)
    const at = rest.lastIndexOf('@')
    if (at <= 0) return false
    const version = rest.slice(at + 1)
    return Boolean(version) && version !== 'latest' && version !== '*'
  }
  if (trimmed.startsWith('file:') || trimmed.startsWith('git+') || trimmed.endsWith('.tgz') || trimmed.endsWith('.tar.gz')) {
    return true
  }
  return false
}

function assertPackageRunnerPinned(name: string, command: string, args: string[]) {
  const base = basename(command)
  if (!PACKAGE_RUNNERS.has(base) && !PACKAGE_RUNNERS.has(command)) return

  // Skip pure runtime flags until the package position. Common patterns:
  // npx -y pkg@1.0.0 | npm exec --yes pkg@1 | bunx pkg@1 | uvx pkg==1.0
  const packageArgs = args.filter((arg) => !arg.startsWith('-'))
  if (packageArgs.length === 0) {
    throw new Error(
      `Local MCP "${name}" uses package runner "${command}" without a package argument. `
      + `Provide a version-pinned package (e.g. package@1.2.3) or an absolute script path.`,
    )
  }
  const spec = packageArgs[0]!
  // uvx uses name==version or name@version
  if ((base === 'uvx' || command === 'uvx') && spec.includes('==') && !spec.endsWith('==') && !spec.includes('==latest')) {
    return
  }
  if (!looksPinnedPackageSpec(spec)) {
    throw new Error(
      `Local MCP "${name}" uses package runner "${command}" with unpinned package "${spec}". `
      + `Pin a version (e.g. ${spec}@1.2.3) or use a local script path. Floating tags like @latest are not allowed.`,
    )
  }
}

export function validateCustomMcpStdioCommand(custom: Pick<CustomMcpConfig, 'name' | 'scope' | 'directory' | 'command' | 'args'>) {
  const command = custom.command?.trim() || ''
  if (!command) {
    throw new Error(`Local MCP "${custom.name}" requires a command.`)
  }

  // Reject shells outright. A shell is never a legitimate MCP runtime
  // on this app — stdio MCPs speak JSON-RPC on stdio, not shell.
  // Catches both bare `sh` and `/bin/bash`.
  if (SHELL_BINARIES.has(basename(command))) {
    throw new Error(
      `Local MCP "${custom.name}" points to a shell ("${command}"). ` +
      `Shells can eval arbitrary code via -c and are not allowed as MCP runtimes — ` +
      `invoke a runtime like node, python, or uv directly.`,
    )
  }

  // Reject inline shell metacharacters in the command field itself.
  // The command is passed to spawn as argv[0]; shell expansion would
  // require `shell: true` which we never set, but we fail early with
  // a clear error when a user pastes `node -e "..."` into the field.
  if (SHELL_METACHARS.test(command)) {
    throw new Error(
      `Local MCP "${custom.name}" command contains shell metacharacters (pipes, redirects, substitution). ` +
      `Enter the runtime executable in "Command" and individual arguments in "Arguments".`,
    )
  }

  // Args inspection. Empty / absent args array is fine — many MCPs
  // specify args through `-y @modelcontextprotocol/server-x` style
  // invocations via the separate Arguments field.
  const args = custom.args || []
  for (const arg of args) {
    if (typeof arg !== 'string') {
      throw new Error(`Local MCP "${custom.name}" has a non-string argument: ${JSON.stringify(arg)}.`)
    }
    if (isScriptEvalArgument(arg)) {
      throw new Error(
        `Local MCP "${custom.name}" uses "${arg}" which evaluates inline code. ` +
        `Ship the MCP as a published npm package (npx …) or a script file on disk instead.`,
      )
    }
    if (SHELL_METACHARS.test(arg)) {
      throw new Error(
        `Local MCP "${custom.name}" has an argument with shell metacharacters: ${JSON.stringify(arg)}. ` +
        `These only work inside a shell, which ${custom.name} does not spawn — pass plain arguments instead.`,
      )
    }
  }

  if (!hasPathSeparator(command) && !isAbsolute(command)) {
    if (!ALLOWED_BARE_COMMANDS.has(command)) {
      throw new Error(
        `Local MCP "${custom.name}" uses "${command}", which is not an allowed bare command. ` +
        `Use a supported runtime like node, npx, python, uv, bun, or provide an absolute executable path.`,
      )
    }
    assertPackageRunnerPinned(custom.name, command, args)
    return
  }

  if (isAbsolute(command)) {
    if (!existingFile(command)) {
      throw new Error(`Local MCP "${custom.name}" points to an executable path that does not exist.`)
    }
    return
  }

  const resolved = resolveProjectRelativePath(command, custom.scope === 'project' ? custom.directory : null)
  if (!resolved) {
    throw new Error(
      `Local MCP "${custom.name}" uses a relative command path that must stay inside the selected project.`,
    )
  }
  if (!existingFile(resolved)) {
    throw new Error(
      `Local MCP "${custom.name}" uses a relative command path that does not point to an existing file.`,
    )
  }
}
