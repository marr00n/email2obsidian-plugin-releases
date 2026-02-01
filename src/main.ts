/* global console, window */
import {
  App,
  ButtonComponent,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
} from 'obsidian';
import { ApiError, listEmails } from './api';
import { runSync, SyncMode } from './pipeline';

export type SyncInterval =
  | '5m'
  | '10m'
  | '15m'
  | '30m'
  | '1h'
  | '3h'
  | '6h'
  | '12h'
  | 'daily';

export interface Email2ObsidianSettings {
  apiKey: string;
  notesFolder: string;
  periodicSync: boolean;
  syncInterval: SyncInterval;
  runOnOpen: boolean;
  lastRunAt: string | null;
  debugLogging: boolean;
}

const SYNC_INTERVALS: SyncInterval[] = [
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '3h',
  '6h',
  '12h',
  'daily',
];

const DEFAULT_SETTINGS: Email2ObsidianSettings = {
  apiKey: '',
  notesFolder: 'E2Oinbox',
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
    helperTip.appendText('This plugin works in tandem with the third party service Email2Obsidian.com. ');
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
        'Paste your Email2Obsidian.com API key. Keep this secret.'
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

    const notesFolderDesc = document.createDocumentFragment();
    notesFolderDesc.append(
      'Destination folder for notes. Folder created automatically if missing.'
    );
    notesFolderDesc.appendChild(document.createElement('br'));
    notesFolderDesc.append(
      "Email attachments follow global settings. These can be adjusted from Obsidian's Files and Links settings."
    );

    new Setting(containerEl)
      .setName('Notes destination folder')
      .setDesc(notesFolderDesc)
      .addText((text) => {
        text.setPlaceholder('(blank for root)');
        text.setValue(this.plugin.settings.notesFolder);
        text.onChange(async (value) => {
          await this.plugin.updateSettings({ notesFolder: value });
        });
      });

    new Setting(containerEl)
      .setHeading()
      .setName('Fetch Notes Automatically');

    new Setting(containerEl)
      .setName('Background fetch')
      .setDesc(
        'Enable background fetching at your chosen interval. When enabled, a sync runs immediately once.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.periodicSync);
        toggle.onChange(async (value) => {
          await this.plugin.updateSettings({ periodicSync: value });
        });
      });

    new Setting(containerEl)
      .setName('Fetch notes on open')
      .setDesc(
        'If enabled, execute fetching of new notes when Obsidian launches.'
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.runOnOpen);
        toggle.onChange(async (value) => {
          await this.plugin.updateSettings({ runOnOpen: value });
        });
      });

    new Setting(containerEl)
      .setName('Fetch interval')
      .setDesc('How frequently would you like to check for new notes? (Only if Background Sync is enabled.)')
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            '5m': 'Every 5 minutes',
            '10m': 'Every 10 minutes',
            '15m': 'Every 15 minutes',
            '30m': 'Every 30 minutes',
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
      .setName('Last fetched')
      .setDesc(
        this.plugin.settings.lastRunAt
          ? this.plugin.settings.lastRunAt
          : 'No runs yet.'
      )
      .setDisabled(true);

    new Setting(containerEl)
      .setHeading()
      .setName('Tips');

    const tipsDesc = document.createDocumentFragment();
    const tipsLine1 = document.createElement('p');
    tipsLine1.textContent =
      'Currently, only emails received from your registered email address will be processed.';
    tipsDesc.appendChild(tipsLine1);

    const tipsLine2 = document.createElement('p');
    tipsLine2.textContent =
      'Tags are supported; both in the subject line and the note body. Tags in the email subject are added to the frontmatter, tags within the email body are not.';
    tipsDesc.appendChild(tipsLine2);

    const tipsLine3 = document.createElement('p');
    const tipsLink = document.createElement('a');
    tipsLink.href = 'https://email2obsidian.com/dashboard';
    tipsLink.textContent = 'Click here';
    tipsLine3.appendChild(tipsLink);
    tipsLine3.append(' to open your account settings.');
    tipsDesc.appendChild(tipsLine3);

    new Setting(containerEl).setDesc(tipsDesc);

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

function normalizeSettings(raw: unknown): Email2ObsidianSettings {
  const candidate =
    raw && typeof raw === 'object'
      ? (raw as Partial<Email2ObsidianSettings>)
      : {};
  const merged = { ...DEFAULT_SETTINGS, ...candidate };

  const notesFolder = normalizeFolder(merged.notesFolder, { allowRoot: true });
  const syncInterval = normalizeSyncInterval(merged.syncInterval);

  return {
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey.trim() : '',
    notesFolder: notesFolder ?? DEFAULT_SETTINGS.notesFolder,
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
    case '5m':
      return 5 * 60 * 1000;
    case '10m':
      return 10 * 60 * 1000;
    case '15m':
      return 15 * 60 * 1000;
    case '30m':
      return 30 * 60 * 1000;
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
