import type { EmailSummary } from './api';

/* -------------------------------------------------------------------------
 * Receive Policy
 *
 * Every install of this plugin reads the same stream. What differs is what
 * each one claims out of it — this module is that answer, and the only place
 * a Vault Marker is compared to anything.
 *
 * Two independent questions, because the user asked for them as two (ADR
 * 0001):
 *
 *   1. Which *marked* email does this Obsidian Vault take? An empty marker
 *      list is the absence of a filter — every marker — not an empty allow
 *      list that claims nothing. That is what makes the shipped default
 *      byte-identical to the plugin's pre-multi-vault behaviour, so an
 *      install upgrades in silence with no migration and no first-run prompt.
 *   2. Does it take Unmarked Email? A plain yes/no, live whatever the marker
 *      list says. Answering it inside the marker list is what made the
 *      rejected wildcard design have a dead field in it.
 *
 * Markers are compared case-insensitively (`CONTEXT.md`): `Work` and `work`
 * name the same Obsidian Vault, and a shifted key should not lose mail.
 *
 * There is no deny list. "Everything except Art" cannot be expressed, on
 * purpose: an install cannot see the other installs, so it cannot know what
 * "everything" is.
 * ---------------------------------------------------------------------- */

/**
 * What separates two Vault Markers in the settings field. A Vault Marker may
 * contain spaces (`Second Brain`), so whitespace cannot separate; a semicolon
 * is not legal inside a marker, and neither is a comma — the semicolon reads
 * less like part of a list of ordinary words.
 */
export const MARKER_SEPARATOR = ';';

/** How an Unmarked Email is keyed wherever markers are counted or stored. */
export const UNMARKED_KEY = '';

/** What an Unmarked Email is called in text the user reads. */
export const UNMARKED_LABEL = 'no marker';

/** A Vault Marker and how many emails arrived under it. */
export interface MarkerCount {
  /** The Vault Marker, or `UNMARKED_KEY` for an Unmarked Email. */
  marker: string;
  count: number;
}

export interface ReceivePolicy {
  /**
   * Does this Obsidian Vault claim an email arriving under this Vault Marker?
   * `null` (and the empty string a ledger entry stores for it) is an Unmarked
   * Email.
   */
  claims(vaultMarker: string | null | undefined): boolean;
}

export interface ReceivePolicyOptions {
  /**
   * The Vault Markers this install claims. Empty means *no marker filter* —
   * every marked email is claimed. Accepts the raw settings string too, so a
   * caller need not parse first.
   */
  markers?: string[] | string | null;
  /** Whether Unmarked Email is claimed. Defaults to true. */
  unmarked?: boolean;
}

export function createReceivePolicy(
  options: ReceivePolicyOptions = {}
): ReceivePolicy {
  const markers = new Set(parseVaultMarkers(options.markers).map(foldCase));
  const unmarked = options.unmarked ?? true;

  return {
    claims(vaultMarker) {
      if (isUnmarked(vaultMarker)) return unmarked;
      // No markers configured is no filter at all, not an empty allow list.
      if (!markers.size) return true;
      return markers.has(foldCase(vaultMarker));
    },
  };
}

/**
 * An email the service returned no Vault Marker for. Narrows, so the other
 * side of the branch is a plain string without anyone having to assert it.
 */
export function isUnmarked(
  vaultMarker: string | null | undefined
): vaultMarker is null | undefined | '' {
  return vaultMarker === null || vaultMarker === undefined || vaultMarker === '';
}

/**
 * Read the markers setting, however it reaches us: the semicolon-separated
 * string the settings field holds, or the list a previous save persisted.
 * Entries are trimmed, empties dropped, and duplicates collapsed
 * case-insensitively — the first spelling wins, so what the user typed is
 * what they see again.
 */
export function parseVaultMarkers(input: unknown): string[] {
  const raw: string[] = [];
  if (typeof input === 'string') {
    raw.push(input);
  } else if (Array.isArray(input)) {
    for (const entry of input) {
      if (typeof entry === 'string') raw.push(entry);
    }
  }

  const seen = new Set<string>();
  const markers: string[] = [];
  for (const chunk of raw) {
    for (const part of chunk.split(MARKER_SEPARATOR)) {
      const marker = part.trim();
      if (!marker.length) continue;
      const key = foldCase(marker);
      if (seen.has(key)) continue;
      seen.add(key);
      markers.push(marker);
    }
  }
  return markers;
}

/** The markers setting as the settings field shows it. */
export function formatVaultMarkers(markers: string[]): string {
  return markers.join(`${MARKER_SEPARATOR} `);
}

/** A Vault Marker as the user reads it, Unmarked Email included. */
export function markerLabel(vaultMarker: string | null | undefined): string {
  return isUnmarked(vaultMarker) ? UNMARKED_LABEL : vaultMarker;
}

/**
 * Count emails per Vault Marker, grouping case-insensitively under the first
 * spelling seen. Ordered by count, then alphabetically, so the marker most
 * worth noticing — most likely the vault the user forgot to set up — reads
 * first and the order does not jitter between runs.
 */
export function tallyMarkers(
  vaultMarkers: (string | null | undefined)[]
): MarkerCount[] {
  const counts = new Map<string, MarkerCount>();
  for (const vaultMarker of vaultMarkers) {
    const marker = isUnmarked(vaultMarker) ? UNMARKED_KEY : vaultMarker;
    const key = foldCase(marker);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    counts.set(key, { marker, count: 1 });
  }

  return Array.from(counts.values()).sort(
    (a, b) =>
      b.count - a.count || markerLabel(a.marker).localeCompare(markerLabel(b.marker))
  );
}

/** `Art (4), Wrok (1)` — what settings shows about the last fetch. */
export function describeDeclines(counts: MarkerCount[]): string {
  return counts
    .map((entry) => `${markerLabel(entry.marker)} (${entry.count})`)
    .join(', ');
}

/**
 * The one thing that betrays an account without vault routing: the service
 * stored no Vault Marker, yet the sender clearly wrote one and it is still
 * sitting in the subject. On an entitled account this cannot happen — the
 * service consumes the token and returns it as the marker.
 *
 * It raises a notice and nothing else. The plugin never re-derives a marker
 * from the subject, which would grant an entitlement the service withheld
 * (ADR 0001), and never strips the token from the note title.
 */
export function hasStarterSignature(
  email: Pick<EmailSummary, 'subject' | 'vaultMarker'>
): boolean {
  return isUnmarked(email.vaultMarker) && email.subject.trimStart().startsWith('@@');
}

function foldCase(value: string): string {
  return value.toLowerCase();
}
