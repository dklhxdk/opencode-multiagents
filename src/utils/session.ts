/**
 * Shared session utilities for council and background managers.
 */

import type { OpencodeClient } from '@opencode-ai/sdk';
import { log } from './logger';

export const SESSION_ABORT_TIMEOUT_MS = 1_000;

export const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9_-]+$/;

export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationTimeoutError';
  }
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (timeoutMs <= 0) return operation;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new OperationTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function abortSessionWithTimeout(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs = SESSION_ABORT_TIMEOUT_MS,
): Promise<void> {
  const result = await withTimeout(
    client.session.abort({ path: { id: sessionId } }),
    timeoutMs,
    `Session abort timed out after ${timeoutMs}ms`,
  );
  const failure = sessionAbortFailure(result);
  if (failure) throw new Error(failure);
}

/**
 * Error message when an SDK abort result reports a rejected request
 * (error envelope or explicit false), or null when the abort was
 * accepted. Both SDK generations resolve rather than throw on HTTP
 * errors, so the envelope must be inspected before counting an abort
 * as done.
 */
export function sessionAbortFailure(result: unknown): string | null {
  if (result === false) return 'session abort returned false';
  if (result && typeof result === 'object') {
    const error = (result as { error?: unknown }).error;
    if (error != null) {
      return `session abort rejected: ${
        typeof error === 'string' ? error : JSON.stringify(error)
      }`;
    }
  }
  return null;
}

/**
 * Parse a model reference string into provider and model IDs.
 * @param model - Model string in format "provider/model"
 * @returns Object with providerID and modelID, or null if invalid
 */
export function parseModelReference(
  model: string,
): { providerID: string; modelID: string } | null {
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= model.length - 1) {
    return null;
  }
  return {
    providerID: model.slice(0, slashIndex),
    modelID: model.slice(slashIndex + 1),
  };
}

/**
 * Send a prompt to a session with optional timeout.
 * If timeout is exceeded, the session is aborted and an error is thrown.
 * @param client - OpenCode client instance
 * @param args - Arguments for session.prompt()
 * @param timeoutMs - Timeout in milliseconds (0 = no timeout)
 * @throws Error if timeout is exceeded
 */
export async function promptWithTimeout(
  client: OpencodeClient,
  args: Parameters<OpencodeClient['session']['prompt']>[0],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('Prompt cancelled');

  const sessionId = args.path.id;
  const hasTimeout = timeoutMs > 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const promptPromise = client.session.prompt(args);
    promptPromise.catch((error) => {
      log('[session] suppressed prompt rejection (race loser)', {
        sessionId,
        error: String(error),
      });
    });

    const racers: Array<Promise<unknown>> = [promptPromise];

    if (hasTimeout) {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new OperationTimeoutError(
                `Prompt timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      );
    }

    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error('Prompt cancelled'));
            return;
          }
          onAbort = () => reject(new Error('Prompt cancelled'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }

    await Promise.race(racers);
  } catch (error) {
    // Abort the server-side session on timeout OR signal cancel. Without
    // the signal branch, a cancelled parent tool leaves the child running
    // as an orphan ("Task cancelled" to the orchestrator, child still
    // working). Match by error identity, not `signal.aborted`, so an
    // unrelated rejection overlapping a signal abort does not fire an
    // extra abort round-trip.
    if (isPromptCancellationError(error)) {
      try {
        await abortSessionWithTimeout(client, sessionId);
      } catch {
        // Best-effort: preserve the original error.
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/** OperationTimeoutError or our own "Prompt cancelled" Error. */
function isPromptCancellationError(error: unknown): boolean {
  if (error instanceof OperationTimeoutError) return true;
  return error instanceof Error && error.message === 'Prompt cancelled';
}
