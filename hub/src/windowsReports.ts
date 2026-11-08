import type { InstalledSoftware, PendingUpdates, WindowsUpdate, WingetUpdate } from './types.js';

export interface InstalledSoftwareReport {
  checkedAt: number;
  items: InstalledSoftware[];
}

function isSoftwareItem(x: unknown): x is InstalledSoftware {
  const v = x as InstalledSoftware;
  return !!v && typeof v.name === 'string' && typeof v.source === 'string' && (v.source === 'winget' || v.source === 'registry');
}

export function isInstalledSoftwareReport(r: unknown): r is InstalledSoftwareReport {
  const x = r as InstalledSoftwareReport;
  return !!x && typeof x.checkedAt === 'number' && Array.isArray(x.items) && x.items.length <= 20_000 && x.items.every(isSoftwareItem);
}

function isWingetUpdate(x: unknown): x is WingetUpdate {
  const v = x as WingetUpdate;
  return !!v && typeof v.id === 'string' && typeof v.name === 'string';
}

function isWindowsUpdate(x: unknown): x is WindowsUpdate {
  const v = x as WindowsUpdate;
  return !!v && typeof v.title === 'string';
}

export function isPendingUpdates(r: unknown): r is PendingUpdates {
  const x = r as PendingUpdates;
  return (
    !!x &&
    typeof x.checkedAt === 'number' &&
    Array.isArray(x.winget) &&
    Array.isArray(x.windows) &&
    x.winget.length <= 2_000 &&
    x.windows.length <= 2_000 &&
    x.winget.every(isWingetUpdate) &&
    x.windows.every(isWindowsUpdate)
  );
}
