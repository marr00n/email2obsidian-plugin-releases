import path from 'path';

export function normalizePath(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.join('/')
    || (normalized.trim() === '.' ? '' : normalized.replace(/\/+$/, ''))
    || '';
}

class FakeAbstractFile {
  path: string;

  constructor(p: string) {
    this.path = normalizePath(p);
  }

  /** Mirrors Obsidian's TAbstractFile.name: the last path segment. */
  get name(): string {
    const idx = this.path.lastIndexOf('/');
    return idx === -1 ? this.path : this.path.slice(idx + 1);
  }
}

export class TFile extends FakeAbstractFile {
  data: ArrayBuffer | null;
  text: string | null;

  constructor(p: string, data: ArrayBuffer | null = null, text: string | null = null) {
    super(p);
    this.data = data;
    this.text = text;
  }
}

export class TFolder extends FakeAbstractFile {
  children: FakeAbstractFile[] = [];

  addChild(file: FakeAbstractFile) {
    this.children.push(file);
  }
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '';
  return p.slice(0, idx);
}

export class Vault {
  private files = new Map<string, FakeAbstractFile>();

  constructor() {
    this.files.set('', new TFolder(''));
  }

  getRoot(): TFolder {
    return this.files.get('') as TFolder;
  }

  getAbstractFileByPath(p: string): FakeAbstractFile | null {
    const normalized = normalizePath(p);
    return this.files.get(normalized) ?? null;
  }

  getFolderByPath(p: string): TFolder | null {
    const file = this.getAbstractFileByPath(p);
    return file instanceof TFolder ? file : null;
  }

  async createFolder(p: string): Promise<void> {
    const normalized = normalizePath(p);
    if (this.files.has(normalized)) {
      throw new Error(`Folder ${normalized} already exists`);
    }
    const folder = new TFolder(normalized);
    this.files.set(normalized, folder);
    this.attachToParent(folder);
  }

  async createBinary(p: string, data: ArrayBuffer): Promise<TFile> {
    const normalized = normalizePath(p);
    const file = new TFile(normalized, data, null);
    this.files.set(normalized, file);
    this.attachToParent(file);
    return file;
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    file.data = data;
  }

  async create(p: string, contents: string): Promise<TFile> {
    const normalized = normalizePath(p);
    const file = new TFile(normalized, null, contents);
    this.files.set(normalized, file);
    this.attachToParent(file);
    return file;
  }

  async process(file: TFile, producer: () => string): Promise<void> {
    file.text = producer();
  }

  private attachToParent(file: FakeAbstractFile) {
    const parentPath = dirname(file.path);
    const parent = this.files.get(parentPath);
    if (parent instanceof TFolder) {
      parent.addChild(file);
    }
  }
}

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
  json: unknown;
}

/**
 * Tests never hit the network: inject an http adapter into createE2oClient
 * instead. This exists so `import { requestUrl } from 'obsidian'` resolves.
 */
export function requestUrl(_param: RequestUrlParam): Promise<RequestUrlResponse> {
  return Promise.reject(
    new Error('requestUrl is unavailable in tests; inject an http adapter.')
  );
}

export class Notice {
  message: string;
  constructor(message: string) {
    this.message = message;
  }
}

export class Setting {}
export class SuggestModal<T> {}
export class PluginSettingTab {}
export class ButtonComponent {}
export class ToggleComponent {}

export class App {
  vault: Vault;
  fileManager: FileManager;
  constructor(vault: Vault) {
    this.vault = vault;
    this.fileManager = new FileManager(undefined, vault);
  }
}

export class Plugin {
  app: App;
  private data: Record<string, unknown> = {};
  constructor(app: App, _manifest?: unknown) {
    this.app = app;
  }
  addCommand() {}
  addSettingTab() {}
  registerInterval() {}
  async loadData() {
    return this.data;
  }
  async saveData(value: Record<string, unknown>) {
    this.data = value;
  }
}

export function normalizePathWithNode(p: string): string {
  return normalizePath(path.normalize(p));
}

export { normalizePath as defaultNormalizePath };

export type AttachmentPathResolver = (name: string, sourcePath: string) => string;

export class FileManager {
  private resolver: AttachmentPathResolver;

  /**
   * Pass a resolver to pin down where attachments land; pass a vault (as `App`
   * does) to get the default "same folder as the source note" resolver.
   *
   * The default resolver insists that `sourcePath` actually names a file in
   * the vault, the way real Obsidian does: `getAvailablePathForAttachment`
   * resolves the user's attachment-location setting relative to the file at
   * `sourcePath`, so with no such file there is nothing to resolve against.
   * A fake that answered from the string alone could not see the ordering bug
   * of commit d2961b6 (attachments saved before the note existed), and the
   * regression test for it would pass with the fix deleted.
   */
  constructor(resolver?: AttachmentPathResolver, vault?: Vault) {
    this.resolver =
      resolver ??
      ((name: string, sourcePath: string) => {
        if (!vault) {
          throw new Error(
            'FileManager fake: construct it with a vault or an explicit resolver.'
          );
        }
        const normalizedSource = normalizePath(sourcePath);
        const source = vault.getAbstractFileByPath(normalizedSource);
        if (!(source instanceof TFile)) {
          throw new Error(
            `Cannot resolve an attachment path against "${normalizedSource}": ` +
              'no such file in the vault. Obsidian resolves attachment ' +
              'locations relative to the source note, so the note must exist first.'
          );
        }
        const parent = dirname(normalizedSource);
        if (!parent) return normalizePath(name);
        return normalizePath(`${parent}/${name}`);
      });
  }

  async getAvailablePathForAttachment(
    name: string,
    sourcePath: string
  ): Promise<string> {
    return normalizePath(this.resolver(name, sourcePath));
  }
}
