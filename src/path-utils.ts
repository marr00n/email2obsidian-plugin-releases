function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, '/');
}

export function joinPosix(...parts: Array<string | undefined | null>): string {
  const filtered = parts.filter((part): part is string => Boolean(part && part.length));
  if (!filtered.length) {
    return '';
  }

  const segments = filtered.map((part, index) => {
    const normalized = normalizeSlashes(part);
    if (index === 0) {
      return normalized.replace(/\/+$/g, '');
    }
    return normalized.replace(/^\/+/, '').replace(/\/+$/g, '');
  });

  return segments.filter((segment) => segment.length > 0).join('/');
}

export function basename(filePath: string, ext?: string): string {
  const normalized = normalizeSlashes(filePath);
  const trimmed = normalized.replace(/\/+$/g, '');
  const index = trimmed.lastIndexOf('/');
  let base = index === -1 ? trimmed : trimmed.slice(index + 1);
  if (ext && ext.length && base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, -ext.length);
  }
  return base;
}

export function extname(filePath: string): string {
  const base = basename(filePath);
  const index = base.lastIndexOf('.');
  if (index <= 0) {
    return '';
  }
  return base.slice(index);
}

export function dirname(filePath: string): string {
  const normalized = normalizeSlashes(filePath).replace(/\/+$/g, '');
  const index = normalized.lastIndexOf('/');
  if (index === -1) {
    return '';
  }
  return normalized.slice(0, index);
}

export function isRootPath(value: string | null | undefined): boolean {
  if (value == null) {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === '.';
}
