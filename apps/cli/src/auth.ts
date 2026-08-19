import { execFile as execFileCb } from "node:child_process";

/**
 * The Anthropic credential the CLI resolved for a given environment, along
 * with enough detail to build an `AnthropicProvider` and to explain to the
 * user where the credential came from.
 */
export type AnthropicCredential =
  | { readonly kind: "api-key"; readonly apiKey: string }
  | {
      readonly kind: "auth-token";
      readonly authToken: string;
      readonly source: "env" | "oauth-profile";
    };

/**
 * Runs an external command and resolves with its stdout/stderr, or rejects
 * on a non-zero exit, a timeout, or a missing binary. Matches the shape of
 * Node's `child_process.execFile` closely enough that the real
 * implementation ({@link defaultExecFile}) and a test stub are
 * interchangeable.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly env?: NodeJS.ProcessEnv },
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const defaultExecFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFileCb(
      file,
      args as string[],
      { timeout: options.timeout, env: options.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

const OAUTH_TIMEOUT_MS = 5000;

export interface ResolveAnthropicCredentialOptions {
  /**
   * Whether to fall back to `ant auth print-credentials --access-token`
   * when no env var credential is present. Defaults to `true`. Set to
   * `false` to only ever resolve from `ANTHROPIC_API_KEY` /
   * `ANTHROPIC_AUTH_TOKEN` (e.g. to skip the ~5s subprocess timeout in a
   * context where `ant` is known not to be installed).
   */
  readonly allowProfile?: boolean;
  /** Injected for tests; defaults to a real `child_process.execFile` call. */
  readonly execFile?: ExecFileFn;
}

/**
 * Resolves the Anthropic credential the CLI should use, mirroring the
 * precedence Anthropic's own SDKs and CLI apply: a non-empty
 * `ANTHROPIC_API_KEY`, then a non-empty `ANTHROPIC_AUTH_TOKEN`, then the
 * OAuth profile created by `ant auth login` (via
 * `ant auth print-credentials --access-token`, which refreshes the token
 * itself if needed and respects `ANTHROPIC_PROFILE`). Returns `undefined`
 * when none of those are available — including when `ant` isn't installed,
 * the command errors, or it times out.
 *
 * Anthropic's own precedence treats an *empty-string* `ANTHROPIC_API_KEY`
 * as "set", which would shadow the profile fallback with an unusable
 * credential. We deliberately deviate here and treat an empty-string env
 * value as unset (same for `ANTHROPIC_AUTH_TOKEN`), so a blank env var
 * doesn't silently defeat OAuth profile resolution.
 */
export async function resolveAnthropicCredential(
  env: Record<string, string | undefined>,
  opts?: ResolveAnthropicCredentialOptions,
): Promise<AnthropicCredential | undefined> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey !== undefined && apiKey !== "") {
    return { kind: "api-key", apiKey };
  }

  const authToken = env.ANTHROPIC_AUTH_TOKEN;
  if (authToken !== undefined && authToken !== "") {
    return { kind: "auth-token", authToken, source: "env" };
  }

  if (opts?.allowProfile === false) return undefined;

  const execFile = opts?.execFile ?? defaultExecFile;
  try {
    const { stdout } = await execFile(
      "ant",
      ["auth", "print-credentials", "--access-token"],
      { timeout: OAUTH_TIMEOUT_MS, env: env as NodeJS.ProcessEnv },
    );
    const token = stdout.trim();
    if (token === "" || token.includes("\n")) return undefined;
    return { kind: "auth-token", authToken: token, source: "oauth-profile" };
  } catch {
    return undefined;
  }
}
