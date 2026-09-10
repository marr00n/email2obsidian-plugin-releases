import { describe, it, expect, vi, afterEach } from 'vitest';

import { createSyncReport, silentSyncReport } from '../src/sync-report';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createSyncReport', () => {
  it('routes notices to the supplied sink, untouched', () => {
    const notices: string[] = [];
    const report = createSyncReport({
      showNotice: (msg) => notices.push(msg),
      debugEnabled: false,
    });

    report.notice('A sync is already in progress.');

    expect(notices).toEqual(['A sync is already in progress.']);
  });

  it('applies the plugin prefix to warnings exactly once, and passes details through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = createSyncReport({ showNotice: () => {}, debugEnabled: false });

    report.warn('Attachment 10: gone');
    report.warn('Sync finished with errors:', ['boom']);

    expect(warn).toHaveBeenNthCalledWith(1, '[Email2Obsidian] Attachment 10: gone');
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[Email2Obsidian] Sync finished with errors:',
      ['boom']
    );
  });

  it('warns regardless of the debug setting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createSyncReport({ showNotice: () => {}, debugEnabled: false }).warn('one');
    createSyncReport({ showNotice: () => {}, debugEnabled: true }).warn('two');

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops debug lines unless debug logging is enabled', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    createSyncReport({ showNotice: () => {}, debugEnabled: false }).debug('quiet');
    expect(debug).not.toHaveBeenCalled();

    createSyncReport({ showNotice: () => {}, debugEnabled: true }).debug('loud');
    expect(debug).toHaveBeenCalledWith('[Email2Obsidian][debug] loud');
  });

  it('keeps notices out of the console and warnings out of the notice sink', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notices: string[] = [];
    const report = createSyncReport({
      showNotice: (msg) => notices.push(msg),
      debugEnabled: true,
    });

    report.notice('toast');
    expect(warn).not.toHaveBeenCalled();

    report.warn('grumble');
    expect(notices).toEqual(['toast']);
  });
});

describe('silentSyncReport', () => {
  it('says nothing on any channel', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const report = silentSyncReport();

    report.notice('toast');
    report.warn('grumble');
    report.debug('timing');

    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });
});
