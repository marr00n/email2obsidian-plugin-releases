/* global console */

/**
 * The one way a sync speaks.
 *
 * Everything under `runSync` — the pipeline, the note writer, the attachment
 * saver, and the two one-time scans it opens (`openLedger`, `openNoteNames`)
 * — reports through this. So does the Service Client `main.ts` builds for
 * `runSync` to read through: its `warn` is wired to `report.warn` once, in
 * `makeClient`, and stays wired even when the report is rebuilt. It exists so
 * the three questions "does the user see this?", "what prefix does it carry?"
 * and "is debug logging on?" each have exactly one answer, in one place,
 * instead of being re-decided at every call site.
 *
 * Deliberately outside the seam, both in `main.ts`: the settings tab's "Test
 * connection" button builds its own ad-hoc `E2oClient` to validate a key
 * before any sync (or report) exists for it, and `normalizeFolder` warns
 * while parsing settings already on disk, well before a report is built for
 * the run that will use them. Both keep the shared `[Email2Obsidian] ` prefix
 * — the button via `prefixedWarn` below, `normalizeFolder` with its own
 * literal — without going through a `SyncReport`.
 *
 * The `[Email2Obsidian] ` prefix for everything that *does* go through this
 * module lives in exactly one place — `prefixedWarn`, below — so `warn`
 * itself, the Service Client's default `warn`, and `openLedger`'s and
 * `openNoteNames`' default `warn` all carry it identically.
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

/**
 * The one place the `[Email2Obsidian] ` prefix is spelled out. `SyncReport`'s
 * own `warn` calls this; so does anything else in the plugin that needs a
 * plugin-prefixed console warning without a full `SyncReport` — the Service
 * Client's default `warn`, `openLedger`'s and `openNoteNames`' default `warn`,
 * and the settings tab's connection test.
 */
export function prefixedWarn(msg: string, ...details: unknown[]): void {
  console.warn(`${WARN_PREFIX} ${msg}`, ...details);
}

export function createSyncReport(opts: SyncReportOptions): SyncReport {
  const { showNotice, debugEnabled } = opts;

  const report: SyncReport = {
    notice(msg: string): void {
      showNotice(msg);
    },
    warn: prefixedWarn,
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
