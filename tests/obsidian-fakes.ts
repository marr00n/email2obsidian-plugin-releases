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

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

/**
 * Stands in for Obsidian's network call. Every test mocks src/api above this
 * level, so reaching here means a request escaped that mock.
 */
export function requestUrl(_options: unknown): Promise<RequestUrlResponse> {
  return Promise.reject(
    new Error('requestUrl called in a test: mock ../src/api instead of hitting the network')
  );
}

export interface Command {
  id: string;
  name: string;
  callback: () => unknown;
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

export class App {
  vault: Vault;
  fileManager: FileManager;
  constructor(vault: Vault) {
    this.vault = vault;
    this.fileManager = new FileManager();
  }
}

export class Plugin {
  app: App;
  /** Commands the plugin registered, so a test can invoke one as a user would. */
  commands: Command[] = [];
  private data: Record<string, unknown> = {};
  constructor(app: App, _manifest?: unknown) {
    this.app = app;
  }
  addCommand(command: Command) {
    this.commands.push(command);
    return command;
  }
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

  constructor(resolver?: AttachmentPathResolver) {
    this.resolver =
      resolver ??
      ((name: string, sourcePath: string) => {
        const parent = dirname(normalizePath(sourcePath));
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
