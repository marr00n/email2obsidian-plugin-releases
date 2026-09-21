/**
 * Strips forwarding/reply chatter ("RE:", "FWD:", ...) off the *start* of an
 * email subject before it becomes a filename or a per-email folder name. The
 * subject stored in the note's own frontmatter is untouched — this only feeds
 * `NoteNamer.reserve`.
 */

export interface SubjectPrefixConfig {
  /**
   * Either a comma-separated list of literal prefixes ("RE:, FWD:, FWD-") or,
   * when `useRegex` is true, a single regular expression source anchored to
   * the start of the subject. Blank or undefined means nothing is stripped.
   */
  value?: string;
  /** Interpret `value` as a regex source rather than a comma-separated list. */
  useRegex?: boolean;
}

/**
 * How many times stripping is retried on the same subject. A forwarded reply
 * can carry several prefixes ("Re: Fwd: Re: Invoice"), so one match is not
 * enough, but nothing legitimate needs more than a handful.
 */
const MAX_STRIP_ITERATIONS = 20;

/** Split `"RE:, FWD:, FWD-"` into `["RE:", "FWD:", "FWD-"]`, dropping blanks. */
export function parsePrefixList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Remove `config`'s prefixes from the start of `subject`, repeatedly, and
 * trim the whitespace a removed prefix leaves behind each time. Never
 * touches anything but the very start of the string — a prefix elsewhere in
 * the subject is left exactly where it was typed.
 *
 * An invalid regex is reported through `warn` and leaves the subject
 * untouched, rather than throwing and failing the whole sync over a typo in
 * settings.
 */
export function stripSubjectPrefixes(
  subject: string,
  config: SubjectPrefixConfig,
  warn?: (msg: string) => void
): string {
  const raw = config.value?.trim();
  if (!raw) return subject;

  if (config.useRegex) {
    return stripByRegex(subject, raw, warn);
  }

  const prefixes = parsePrefixList(raw);
  if (!prefixes.length) return subject;
  return stripByList(subject, prefixes);
}

function stripByRegex(subject: string, source: string, warn?: (msg: string) => void): string {
  let pattern: RegExp;
  try {
    // Anchored here rather than trusting the user to anchor it themselves —
    // an unanchored pattern would strip a match from the middle of the
    // subject too, which is never what "strip a prefix" means.
    pattern = new RegExp(`^(?:${source})`, 'i');
  } catch (error) {
    warn?.(
      `Subject prefix pattern is not a valid regular expression, so it is not being applied: ${
        (error as Error).message
      }`
    );
    return subject;
  }

  let result = subject;
  for (let i = 0; i < MAX_STRIP_ITERATIONS; i += 1) {
    const stripped = result.replace(pattern, '').replace(/^\s+/, '');
    if (stripped === result) break;
    result = stripped;
  }
  return result;
}

function stripByList(subject: string, prefixes: string[]): string {
  let result = subject;
  for (let i = 0; i < MAX_STRIP_ITERATIONS; i += 1) {
    const trimmed = result.replace(/^\s+/, '');
    const match = prefixes.find((prefix) => trimmed.toLowerCase().startsWith(prefix.toLowerCase()));
    if (!match) return trimmed;
    result = trimmed.slice(match.length);
  }
  return result.replace(/^\s+/, '');
}
