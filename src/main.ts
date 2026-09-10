/* global console, window, document */
import {
  App,
  ButtonComponent,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  ToggleComponent,
  normalizePath,
} from 'obsidian';
import { ApiError, createE2oClient, type E2oClient } from './api';
import { runSync, SyncMode } from './pipeline';
import { openLedger, type PendingRelease } from './fetch-ledger';
import { isRootPath } from './path-utils';
import {
  describeDeclines,
  filtersByMarker,
  formatVaultMarkers,
  parseVaultMarkers,
  receivePolicyFor,
  type MarkerCount,
} from './receive-policy';
import { createSyncReport, prefixedWarn, type SyncReport } from './sync-report';

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
  /**
   * The Vault Markers this Obsidian Vault claims. Empty is the absence of a
   * filter — every marker — which is what makes the shipped default identical
   * to how the plugin behaved before it could tell vaults apart.
   */
  vaultMarkers: string[];
  /** Whether this Obsidian Vault takes Unmarked Email. */
  receiveUnmarked: boolean;
  /** What the last fetch turned away, so settings can say so between runs. */
  lastDeclined: MarkerCount[];
  /** The last fetch saw the one signature of an account without vault routing. */
  starterSignatureSeen: boolean;
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
  vaultMarkers: [],
  receiveUnmarked: true,
  lastDeclined: [],
  starterSignatureSeen: false,
};

export default class Email2ObsidianPlugin extends Plugin {
  settings: Email2ObsidianSettings = { ...DEFAULT_SETTINGS };
  private isSyncing = false;
  private intervalHandle: number | null = null;
  /**
   * The one seam everything under a sync reports through. Rebuilt whenever
   * settings change so the debug toggle takes effect immediately; the Obsidian
   * half (`Notice`, `console`) is wired here and nowhere else.
   */
  private report: SyncReport = this.makeReport(false);
  private client: E2oClient = this.makeClient('');

  async onload(): Promise<void> {
    await this.loadSettings();
    this.report = this.makeReport(this.settings.debugLogging);
    this.client = this.makeClient(this.settings.apiKey);

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
    const prevApiKey = this.settings.apiKey;
    this.settings = normalizeSettings({ ...this.settings, ...partial });
    this.report = this.makeReport(this.settings.debugLogging);
    if (this.settings.apiKey !== prevApiKey) {
      this.client = this.makeClient(this.settings.apiKey);
    }
    await this.saveSettings();
    const shouldRunImmediately =
      !prevPeriodic && this.settings.periodicSync === true;
    this.setupScheduler(shouldRunImmediately);
  }

  private makeReport(debugEnabled: boolean): SyncReport {
    return createSyncReport({
      showNotice: (msg) => {
        new Notice(msg);
      },
      debugEnabled,
    });
  }

  /**
   * The client warns through whichever report is current — the arrow reads
   * `this.report` at call time, so rebuilding the report does not strand it.
   */
  private makeClient(apiKey: string): E2oClient {
    return createE2oClient({
      apiKey,
      warn: (msg) => this.report.warn(msg),
    });
  }

  /** Public because the settings panel's Fetch now button starts one too. */
  async handleSync(mode: SyncMode) {
    if (this.isSyncing) {
      this.report.debug('handleSync ignored: already syncing');
      this.report.notice('A sync is already in progress.');
      return;
    }

    const runStart = Date.now();
    this.isSyncing = true;
    try {
      const result = await runSync({
        mode,
        settings: this.settings,
        vault: this.app.vault,
        plugin: this,
        client: this.client,
        report: this.report,
      });

      this.settings.lastRunAt = new Date().toISOString();
      // What settings shows between runs, replaced rather than merged: both
      // describe one fetch, so a run that declined nothing has to clear the
      // previous run's readout rather than leave it standing.
      //
      // Except when the run found no new email at all. A background poll that
      // met a quiet account has learned nothing, and wiping the readout on it
      // would make `Last fetch declined: Art (4)` disappear from settings
      // between the sync that discovered it and the user opening the tab.
      if (result.synced + result.declined + result.errors.length > 0) {
        this.settings.lastDeclined = result.declinedByMarker;
        this.settings.starterSignatureSeen = result.starterSignature;
      }
      await this.saveSettings();

      this.report.debug(
        `handleSync completed in ${Date.now() - runStart}ms; errors=${result.errors.length}, attachmentErrors=${result.attachmentErrors.length}`
      );

      if (result.errors.length) {
        this.report.warn('Sync finished with errors:', result.errors);
      }
      if (result.attachmentErrors.length) {
        this.report.warn('Attachment issues:', result.attachmentErrors);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown sync error.';
      this.report.notice(`Sync didn't finish: ${message}`);
      this.report.warn('Sync failed', error);
    } finally {
      this.isSyncing = false;
    }
  }

  private setupScheduler(triggerImmediate = false) {
    if (this.intervalHandle) {
      window.clearInterval(this.intervalHandle);
      this.report.debug('Cleared existing sync interval');
      this.intervalHandle = null;
    }

    if (!this.settings.periodicSync) {
      this.report.debug('Periodic sync disabled; scheduler not started');
      return;
    }

    const delay = syncIntervalToMs(this.settings.syncInterval);

    if (triggerImmediate) {
      this.report.debug('Triggering immediate sync on scheduler start');
      void this.handleSync('fetch-new');
    }

    this.intervalHandle = window.setInterval(() => {
      void this.handleSync('fetch-new');
    }, delay);
    this.report.debug(`Scheduled periodic sync every ${delay}ms`);
  }

  onunload(): void {
    if (this.intervalHandle) {
      window.clearInterval(this.intervalHandle);
    }
  }
}

class Email2ObsidianSettingTab extends PluginSettingTab {
  plugin: Email2ObsidianPlugin;
  /**
   * The one row that changes while the user types. Held rather than
   * re-rendered, because re-rendering the tab on every keystroke would take
   * the cursor out of the field being typed into.
   */
  private releaseSetting: Setting | null = null;
  private releaseButton: ButtonComponent | null = null;
  /** Guards against an earlier keystroke's slower read landing last. */
  private releaseToken = 0;
  /** Held for the same reason: it turns live as the markers field fills in. */
  private unmarkedSetting: Setting | null = null;
  private unmarkedToggle: ToggleComponent | null = null;
  /**
   * Obsidian's `ToggleComponent.setValue` fires `onChange`, so redrawing the
   * toggle would otherwise save the value it is only displaying — and
   * overwrite the answer the user gave while their markers were still filled
   * in. Set while this tab drives the control itself.
   */
  private redrawingUnmarked = false;

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

    this.displayVaultMarkers(containerEl);

    new Setting(containerEl)
      .setHeading()
      .setName('Tips');

    const tipsDesc = document.createDocumentFragment();
    const tipsList = document.createElement('ul');
    tipsDesc.appendChild(tipsList);

    /** The literal syntax a tip is telling the user to type. */
    const code = (text: string): HTMLElement => {
      const el = document.createElement('code');
      el.textContent = text;
      return el;
    };
    const addTip = (...parts: (string | Node)[]): void => {
      const item = document.createElement('li');
      item.append(...parts);
      tipsList.appendChild(item);
    };

    addTip(
      'Email Security: Only emails sent from your registered email address are processed.'
    );
    addTip(
      'Vault Routing: Direct a note to a specific vault using ',
      code('@@VaultName'),
      ' or ',
      code('@@"Vault Name"'),
      ' in the email subject. A space must precede ',
      code('@@'),
      '. (Pro plans only)'
    );
    addTip(
      'Hashtags: Add ',
      code('#tags'),
      " anywhere in your subject line or note body. Tags in the subject line are added to the note's frontmatter, while body tags remain in the body content. Multiple tags are supported, and spaces within multi-word tags are converted to underscores (e.g. ",
      code('#follow_up'),
      ').'
    );
    addTip('Attachments: Inline and file attachments are supported.');

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

  /**
   * What this Obsidian Vault claims out of the shared stream (ADR 0001). Two
   * controls, because the user has two separate questions: which marked email
   * do I want, and do I want the unmarked kind at all.
   *
   * The heading and the Markers description carry the owner's copy; the rest
   * is still placeholder and needs rewriting before release.
   */
  private displayVaultMarkers(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl)
      .setHeading()
      .setName('Vault Routing (Pro Only)')
      .setDesc('Choose what this vault takes out of your Email2Obsidian account.');

    const markersDesc = document.createDocumentFragment();
    markersDesc.append(
      'Specify a marker to have only those emails fetched into this vault. ' +
        'Leave blank to receive all marked emails.'
    );
    if (settings.lastDeclined.length) {
      markersDesc.appendChild(document.createElement('br'));
      // Diagnostic only: it reports what was turned away and never proposes a
      // marker. A marker nobody has sent to recently is indistinguishable
      // from one the user mistyped, so nothing here can be a suggestion.
      // Not "last fetch": a quiet background poll deliberately leaves this
      // standing rather than wiping a tally the user has not seen yet, so the
      // wording must not claim the most recent run is what produced it.
      markersDesc.append(`Recently declined: ${describeDeclines(settings.lastDeclined)}`);
    }

    new Setting(containerEl)
      .setName('Markers')
      .setDesc(markersDesc)
      .addText((text) => {
        text.setPlaceholder('Example: work; second brain');
        text.setValue(formatVaultMarkers(settings.vaultMarkers));
        text.onChange(async (value) => {
          await this.plugin.updateSettings({ vaultMarkers: parseVaultMarkers(value) });
          // Typing the first marker is what gives the unmarked question
          // something to do; clearing the last one takes it away again.
          this.refreshUnmarkedControl();
          await this.refreshPendingRelease();
        });
      });

    this.unmarkedSetting = new Setting(containerEl)
      .setName('Unmarked emails')
      .addToggle((toggle) => {
        this.unmarkedToggle = toggle;
        toggle.onChange(async (value) => {
          if (this.redrawingUnmarked) return;
          await this.plugin.updateSettings({ receiveUnmarked: value });
          await this.refreshPendingRelease();
        });
      });
    this.refreshUnmarkedControl();

    this.releaseSetting = new Setting(containerEl)
      .setName('Held-back email')
      .setDesc('Nothing is waiting.')
      .addButton((button) => {
        this.releaseButton = button;
        button.setButtonText('Fetch now');
        button.setDisabled(true);
        button.onClick(() => {
          void this.plugin.handleSync('fetch-new').then(() => this.display());
        });
      });
    void this.refreshPendingRelease();

    if (settings.starterSignatureSeen) {
      new Setting(containerEl)
        .setName('Vault routing is not active on your account')
        .setDesc(
          'Email arrived with @@ still in the subject, which means the ' +
            'service is not reading markers for your account. Notes still ' +
            'import, with the @@ text left in the title, and the markers ' +
            'above have nothing to match until vault routing is enabled.'
        );
    }
  }

  /**
   * The unmarked question only exists once the markers field narrows anything.
   * A blank field means this vault takes the whole stream, so the toggle reads
   * on and goes dead rather than moving without effect — the dead-field defect
   * that sank the wildcard design (ADR 0001).
   *
   * The stored answer is left alone, so filling the markers field back in
   * restores the user's own choice rather than a default.
   */
  private refreshUnmarkedControl(): void {
    const setting = this.unmarkedSetting;
    const toggle = this.unmarkedToggle;
    if (setting === null || toggle === null) return;

    const filtering = filtersByMarker(this.plugin.settings.vaultMarkers);
    setting.setDesc(
      filtering
        ? 'Take emails sent without a marker.'
        : 'Unmarked emails always arrive while the markers field is blank, ' +
            'because a blank field takes everything. List a marker above to ' +
            'choose.'
    );

    this.redrawingUnmarked = true;
    toggle.setValue(filtering ? this.plugin.settings.receiveUnmarked : true);
    toggle.setDisabled(!filtering);
    this.redrawingUnmarked = false;
  }

  /**
   * Ask the Fetch Ledger what the markers now in the field would bring back
   * in. A read of what is already on disk — the count has to be right while
   * the user is offline or rate limited, so it never touches the network.
   */
  private async refreshPendingRelease(): Promise<void> {
    const token = (this.releaseToken += 1);
    const ledger = await openLedger(this.plugin, { warn: prefixedWarn });
    const pending: PendingRelease = ledger.pendingRelease(
      receivePolicyFor(this.plugin.settings)
    );

    // A slower read from an earlier keystroke must not overwrite a later one.
    if (token !== this.releaseToken) return;
    const setting = this.releaseSetting;
    const button = this.releaseButton;
    // Compared rather than tested for truthiness: Obsidian's Setting and
    // ButtonComponent both carry a `then`, so a bare `!setting` reads as a
    // misused promise.
    if (setting === null || button === null) return;

    if (!pending.total) {
      setting.setDesc('Nothing is waiting.');
      button.setDisabled(true);
      return;
    }

    const emails = pending.total === 1 ? '1 email' : `${pending.total} emails`;
    setting.setDesc(
      `${emails} turned away by your previous markers will arrive on the next ` +
        `fetch: ${describeDeclines(pending.byMarker)}.`
    );
    button.setDisabled(false);
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
      await createE2oClient({ apiKey, warn: prefixedWarn }).listEmails({
        sort: 'date-desc',
      });
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
    // The settings field hands this over as the raw semicolon-separated
    // string; a previous save hands over the parsed list. Both land here.
    vaultMarkers: parseVaultMarkers(merged.vaultMarkers),
    // Absent means yes — an install upgrading into this feature keeps taking
    // the Unmarked Email it always took.
    receiveUnmarked: merged.receiveUnmarked === undefined
      ? DEFAULT_SETTINGS.receiveUnmarked
      : Boolean(merged.receiveUnmarked),
    lastDeclined: normalizeMarkerCounts(merged.lastDeclined),
    starterSignatureSeen: Boolean(merged.starterSignatureSeen),
    lastRunAt:
      typeof merged.lastRunAt === 'string' && merged.lastRunAt.length > 0
        ? merged.lastRunAt
        : null,
  };
}

function normalizeMarkerCounts(input: unknown): MarkerCount[] {
  if (!Array.isArray(input)) return [];
  const counts: MarkerCount[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) continue;
    if (typeof entry.marker !== 'string') continue;
    if (typeof entry.count !== 'number' || !Number.isFinite(entry.count)) continue;
    counts.push({ marker: entry.marker, count: entry.count });
  }
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
  // Only '.' can reach here (the empty case is handled above), so this is
  // the same root check note-folder.ts resolves against at sync time —
  // reused here just to recognize it, not to convert it: settings persist
  // '.' as typed, and note-folder.ts is the one place that turns it into ''.
  if (options.allowRoot && isRootPath(trimmed)) {
    return trimmed;
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
  normalizeMarkerCounts,
  normalizeSettings,
  normalizeFolder,
  normalizeSyncInterval,
  syncIntervalToMs,
};
