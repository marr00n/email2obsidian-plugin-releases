/* global console, window */
import {
  App,
  ButtonComponent,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  SuggestModal,
  TFolder,
  normalizePath,
} from 'obsidian';
import { ApiError, listEmails } from './api';
import { runSync, SyncMode } from './pipeline';

export type SyncInterval = '1h' | '3h' | '6h' | '12h' | 'daily';

export interface Email2ObsidianSettings {
  apiKey: string;
  notesFolder: string;
  attachmentFolder: string | null;
  periodicSync: boolean;
  syncInterval: SyncInterval;
  runOnOpen: boolean;
  lastRunAt: string | null;
  debugLogging: boolean;
}

const SYNC_INTERVALS: SyncInterval[] = ['1h', '3h', '6h', '12h', 'daily'];

const DEFAULT_SETTINGS: Email2ObsidianSettings = {
  apiKey: '',
  notesFolder: 'E2Oinbox',
  attachmentFolder: null,
  periodicSync: false,
  syncInterval: 'daily',
  runOnOpen: false,
  lastRunAt: null,
  debugLogging: false,
};

export default class Email2ObsidianPlugin extends Plugin {
  settings: Email2ObsidianSettings = { ...DEFAULT_SETTINGS };
  private isSyncing = false;
  private intervalHandle: number | null = null;
  private debugLog = createDebugLogger(false);

  async onload(): Promise<void> {
    await this.loadSettings();
    this.debugLog = createDebugLogger(this.settings.debugLogging);

    this.addSettingTab(new Email2ObsidianSettingTab(this.app, this));

    this.addCommand({
      id: 'fetch-new',
      name: 'Fetch new notes',
      callback: () => void this.handleSync('fetch-new'),
    });

    this.addCommand({
      id: 'fetch-all',
      name: 'Fetch all notes',
      callback: () => void this.handleSync('fetch-all'),
    });

    if (this.settings.runOnOpen) {
      void this.handleSync('fetch-new');
    }

    this.setupScheduler(false);
  }

  async loadSettings(): Promise<void> {
    const raw: unknown = await this.loadData();
    const envelope = isRecord(raw) ? raw : {};
    const stored =
      Object.prototype.hasOwnProperty.call(envelope, 'settings')
        ? envelope.settings
        : raw;
    this.settings = normalizeSettings(stored);
  }

  async saveSettings(): Promise<void> {
    const raw: unknown = await this.loadData();
    const envelope = isRecord(raw) ? { ...raw } : {};
    envelope.settings = this.settings;
    await this.saveData(envelope);
  }

  async updateSettings(partial: Partial<Email2ObsidianSettings>): Promise<void> {
    const prevPeriodic = this.settings.periodicSync;
    this.settings = normalizeSettings({ ...this.settings, ...partial });
    this.debugLog = createDebugLogger(this.settings.debugLogging);
    await this.saveSettings();
    const shouldRunImmediately =
      !prevPeriodic && this.settings.periodicSync === true;
    this.setupScheduler(shouldRunImmediately);
  }

  private async handleSync(mode: SyncMode) {
    if (this.isSyncing) {
      this.debugLog('handleSync ignored: already syncing');
      new Notice('A sync is already in progress.');
      return;
    }

    const runStart = Date.now();
    this.isSyncing = true;
    try {
      const result = await runSync(
        {
          mode,
          settings: this.settings,
          vault: this.app.vault,
          plugin: this,
        },
        (msg) => new Notice(msg)
      );

      this.settings.lastRunAt = new Date().toISOString();
      await this.saveSettings();

      this.debugLog(
        `handleSync completed in ${Date.now() - runStart}ms; errors=${result.errors.length}, attachmentErrors=${result.attachmentErrors.length}`
      );

      if (result.errors.length) {
        console.warn(
          '[Email2Obsidian] Sync finished with errors:',
          result.errors
        );
      }
      if (result.attachmentErrors.length) {
        console.warn('[Email2Obsidian] Attachment issues:', result.attachmentErrors);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown sync error.';
      new Notice(`Sync didn't finish: ${message}`);
      console.warn('[Email2Obsidian] Sync failed', error);
    } finally {
      this.isSyncing = false;
    }
  }

  private setupScheduler(triggerImmediate = false) {
    if (this.intervalHandle) {
      window.clearInterval(this.intervalHandle);
      this.debugLog('Cleared existing sync interval');
      this.intervalHandle = null;
    }

    if (!this.settings.periodicSync) {
      this.debugLog('Periodic sync disabled; scheduler not started');
      return;
    }

    const delay = syncIntervalToMs(this.settings.syncInterval);

    if (triggerImmediate) {
      this.debugLog('Triggering immediate sync on scheduler start');
      void this.handleSync('fetch-new');
    }

    this.intervalHandle = window.setInterval(() => {
      void this.handleSync('fetch-new');
    }, delay);
    this.debugLog(`Scheduled periodic sync every ${delay}ms`);
  }

  onunload(): void {
    if (this.intervalHandle) {
      window.clearInterval(this.intervalHandle);
    }
  }
}

class Email2ObsidianSettingTab extends PluginSettingTab {
  plugin: Email2ObsidianPlugin;

  constructor(app: App, plugin: Email2ObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const helperTip = containerEl.createEl('div');
    helperTip.addClass('setting-item-description');
    helperTip.appendText('This plugin works in tandem with the third party service Email2Obsidian. ');
    helperTip.createEl('a', {
      href: 'https://email2obsidian.com',
      text: 'Get started for free.',
    });

    new Setting(containerEl)
      .setHeading()
      .setName('Set up');

    new Setting(containerEl)
      .setName('API key')
      .setDesc(
        'Paste your Email2Obsidian API key (sent as x-api-key). Keep this secret.'
      )
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Example: 12345678-1234-1234-1234-123456789abc');
        text.setValue(this.plugin.settings.apiKey);
        text.onChange(async (value) => {
          await this.plugin.updateSettings({ apiKey: value });
        });
      })
      .addButton((button) => {
        button.setButtonText('Test connection');
        button.setTooltip('Test connection to Email2Obsidian');
        button.onClick(() => {
          void this.testConnection(button);
        });
      });

    new Setting(containerEl)
      .setName('Notes destination folder')
      .setDesc(
        'Destination folder for notes. Leave blank or "." to save directly into the vault root. Created automatically if missing.'
      )
      .addText((text) => {
        text.setPlaceholder('(blank for root)');
        text.setValue(this.plugin.settings.notesFolder);
        text.onChange(async (value) => {
          await this.plugin.updateSettings({ notesFolder: value });
        });
      });

    const attachmentSetting = new Setting(containerEl)
      .setName('Attachment folder (optional)')
      .setDesc(
        'Store attachments separately; inline and non-inline references will point here. Leave blank to save attachments beside each note.'
      );

    const folder = this.plugin.settings.attachmentFolder;
    const desc = attachmentSetting.descEl.createDiv({ cls: 'setting-item-description' });
    desc.createSpan({ text: 'Current: ' });

    const currentLabel = folder
      ? desc.createSpan({ text: `/${folder}` })
      : desc.createSpan({ text: 'Beside each note (default)' });

    currentLabel.addClass('email2obsidian-attachment-label');

    attachmentSetting.addButton((button) => {
      button.setButtonText(
        this.plugin.settings.attachmentFolder
          ? 'Change folder'
          : 'Choose folder'
      );
      button.setTooltip('Select from existing vault folders');
      button.onClick(() => {
        const folders = getVaultFolders(this.app);
        if (!folders.length) {
          new Notice('No folders available in this vault yet.');
          return;
        }
        const modal = new FolderSuggestModal(this.app, folders, (value) => {
          void this.plugin
            .updateSettings({ attachmentFolder: value })
            .then(() => this.display())
            .catch((error) => {
              console.warn('[Email2Obsidian] Failed to update attachment folder', error);
              new Notice('Failed to update attachment folder.');
            });
        });
        modal.open();
      });
    });

    attachmentSetting.addExtraButton((button) => {
      button.setIcon('x-circle');
      button.setTooltip('Save attachments beside each note');
      button.setDisabled(!this.plugin.settings.attachmentFolder);
      button.onClick(async () => {
        await this.plugin.updateSettings({ attachmentFolder: null });
        this.display();
      });
    });

    const helper = containerEl.createEl('div');
    helper.addClass('setting-item-description');
    helper.setText(
      'Inline attachments are embedded in body; other attachments are listed under attachments. All filenames are collision-safe and folders are auto-created.'
    );

    new Setting(containerEl)
      .setName('Sync on open')
      .setDesc(
        'If enabled, syncs when Obsidian launches. Periodic sync countdown also restarts on each open.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.runOnOpen);
        toggle.onChange(async (value) => {
          await this.plugin.updateSettings({ runOnOpen: value });
        });
      });


    new Setting(containerEl)
      .setHeading()
      .setName('Sync');

    new Setting(containerEl)
      .setName('Periodic sync')
      .setDesc(
        'Enable background syncing at a fixed interval. When enabled, a sync runs immediately once.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.periodicSync);
        toggle.onChange(async (value) => {
          await this.plugin.updateSettings({ periodicSync: value });
        });
      });

    new Setting(containerEl)
      .setName('Sync interval')
      .setDesc('Interval for periodic syncs (1h, 3h, 6h, 12h, daily).')
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            '1h': 'Every hour',
            '3h': 'Every 3 hours',
            '6h': 'Every 6 hours',
            '12h': 'Every 12 hours',
            daily: 'Daily',
          })
          .setValue(this.plugin.settings.syncInterval)
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              syncInterval: value as SyncInterval,
            });
          });
      });

    new Setting(containerEl)
      .setName('Last sync run')
      .setDesc(
        this.plugin.settings.lastRunAt
          ? this.plugin.settings.lastRunAt
          : 'No runs yet.'
      )
      .setDisabled(true);


    new Setting(containerEl)
      .setHeading()
      .setName('Debug')
      .setDesc(
        'Warnings are stored in Obsidian’s developer console. Open it via View -> Toggle Developer Tools (Cmd+Opt+I / Ctrl+Shift+I) and check the Console tab.'
      );

    new Setting(containerEl)
      .setName('Debug logging')
      .setDesc('Log detailed timings for email fetch, pagination, and attachments to the console.')
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.debugLogging);
        toggle.onChange(async (value) => {
          await this.plugin.updateSettings({ debugLogging: value });
        });
      });
  }

  private async testConnection(button: ButtonComponent) {
    const btn = button;
    const apiKey = this.plugin.settings.apiKey.trim();
    if (!apiKey) {
      new Notice('Enter your API key to test the connection.', 4000);
      return;
    }

    const originalText = btn.buttonEl.innerText;
    btn.setDisabled(true);
    btn.setButtonText('Testing…');

    try {
      await listEmails({ apiKey, sort: 'date-desc' });
      new Notice('Connected to Email2Obsidian.', 3000);
    } catch (error) {
      if (error instanceof ApiError) {
        new Notice(error.message, 5000);
      } else {
        new Notice(
          `Couldn’t reach Email2Obsidian right now: ${(error as Error).message ?? 'Unknown error'}`,
          5000
        );
      }
    } finally {
      btn.setDisabled(false);
      btn.setButtonText(originalText);
    }
  }
}

class FolderSuggestModal extends SuggestModal<string> {
  private readonly folders: string[];
  private readonly onSelect: (value: string) => void;

  constructor(app: App, folderPaths: string[], onSelect: (value: string) => void) {
    super(app);
    this.folders = folderPaths;
    this.onSelect = onSelect;
    this.setPlaceholder('Filter folders…');
  }

  getSuggestions(query: string): string[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized.length) {
      return this.folders;
    }
    return this.folders.filter((folder) =>
      folder.toLowerCase().includes(normalized)
    );
  }

  renderSuggestion(folder: string, el: HTMLElement) {
    el.createEl('div', { text: folder });
  }

  onChooseSuggestion(folder: string) {
    this.onSelect(folder);
  }
}

function getVaultFolders(app: App): string[] {
  const folders: string[] = [];
  const root = app.vault.getRoot();

  const visit = (folder: TFolder) => {
    if (folder.path && folder.path.length > 0) {
      folders.push(folder.path);
    }
    for (const child of folder.children) {
      if (child instanceof TFolder) {
        visit(child);
      }
    }
  };

  visit(root);
  folders.sort((a, b) => a.localeCompare(b));
  return folders;
}

function normalizeSettings(raw: unknown): Email2ObsidianSettings {
  const candidate =
    raw && typeof raw === 'object'
      ? (raw as Partial<Email2ObsidianSettings>)
      : {};
  const merged = { ...DEFAULT_SETTINGS, ...candidate };

  const notesFolder = normalizeFolder(merged.notesFolder, { allowRoot: true });
  const attachmentFolder = normalizeFolder(merged.attachmentFolder);
  const syncInterval = normalizeSyncInterval(merged.syncInterval);

  return {
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey.trim() : '',
    notesFolder: notesFolder ?? DEFAULT_SETTINGS.notesFolder,
    attachmentFolder: attachmentFolder ?? null,
    periodicSync: Boolean(merged.periodicSync),
    syncInterval,
    runOnOpen: Boolean(merged.runOnOpen),
    debugLogging: Boolean(merged.debugLogging),
    lastRunAt:
      typeof merged.lastRunAt === 'string' && merged.lastRunAt.length > 0
        ? merged.lastRunAt
        : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createDebugLogger(enabled: boolean): (msg: string) => void {
  if (!enabled) {
    return () => {};
  }
  return (msg: string) => console.debug(`[Email2Obsidian][debug] ${msg}`);
}

function normalizeFolder(
  input: unknown,
  options: { allowRoot?: boolean } = {}
): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.length) {
    return options.allowRoot ? '' : null;
  }
  if (options.allowRoot && trimmed === '.') {
    return '.';
  }
  try {
    return normalizePath(trimmed);
  } catch (error) {
    console.warn('[Email2Obsidian] Failed to normalize path', error);
    return null;
  }
}

function normalizeSyncInterval(value: unknown): SyncInterval {
  if (typeof value === 'string' && SYNC_INTERVALS.includes(value as SyncInterval)) {
    return value as SyncInterval;
  }
  return DEFAULT_SETTINGS.syncInterval;
}

function syncIntervalToMs(interval: SyncInterval): number {
  switch (interval) {
    case '1h':
      return 60 * 60 * 1000;
    case '3h':
      return 3 * 60 * 60 * 1000;
    case '6h':
      return 6 * 60 * 60 * 1000;
    case '12h':
      return 12 * 60 * 60 * 1000;
    case 'daily':
    default:
      return 24 * 60 * 60 * 1000;
  }
}

// Exported for testing
export {
  normalizeSettings,
  normalizeFolder,
  normalizeSyncInterval,
  syncIntervalToMs,
};
