/* global console */

/**
 * The one way a sync speaks.
 *
 * Everything under `runSync` — the pipeline, the note writer, the attachment
 * saver, the Service Client — reports through this and nothing else. It exists
 * so the three questions "does the user see this?", "what prefix does it
 * carry?" and "is debug logging on?" each have exactly one answer, in one
 * place, instead of being re-decided at every call site.
 *
 * The Obsidian-facing half (`Notice`, `console`) is supplied once by `main.ts`;
 * nothing downstream imports either.
 */
export interface SyncReport {
  /** A toast the user sees. */
  notice(msg: string): void;
  /**
   * A console warning. The `[Email2Obsidian] ` prefix is added here — callers
   * pass the bare message. Extra `details` are handed to `console.warn`
   * untouched, so objects stay inspectable in devtools.
   */
  warn(msg: string, ...details: unknown[]): void;
  /**
   * A timing/diagnostic line, carrying the `[Email2Obsidian][debug] ` prefix.
   * Dropped entirely unless debug logging is on, so callers can build messages
   * freely — the cost of a disabled `debug` call is one empty function call.
   */
  debug(msg: string): void;
}

export interface SyncReportOptions {
  /** How a toast reaches the user. `main.ts` passes Obsidian's `Notice`. */
  showNotice: (msg: string) => void;
  /** The `debugLogging` setting: false makes `debug` a no-op. */
  debugEnabled: boolean;
}

const WARN_PREFIX = '[Email2Obsidian]';
const DEBUG_PREFIX = '[Email2Obsidian][debug]';

export function createSyncReport(opts: SyncReportOptions): SyncReport {
  const { showNotice, debugEnabled } = opts;

  const report: SyncReport = {
    notice(msg: string): void {
      showNotice(msg);
    },
    warn(msg: string, ...details: unknown[]): void {
      console.warn(`${WARN_PREFIX} ${msg}`, ...details);
    },
    debug: debugEnabled
      ? (msg: string): void => {
          console.debug(`${DEBUG_PREFIX} ${msg}`);
        }
      : (): void => {},
  };

  return report;
}

/**
 * A report that says nothing. For tests, and for the rare caller that wants a
 * sync to run without narrating itself.
 */
export function silentSyncReport(): SyncReport {
  return {
    notice: () => {},
    warn: () => {},
    debug: () => {},
  };
}
