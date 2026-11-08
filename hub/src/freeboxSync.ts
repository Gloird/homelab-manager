// Freebox OS Synchronization
// Polls Freebox API and updates equipment with native checks

import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { equipments, freeboxMetrics, settings } from './db.js';
import { publish } from './events.js';
import { loadSites } from './catalog.js';
import type { EquipmentDoc, EquipmentNative, FreeboxSettings, AlertLevel } from './types.js';
import { createFreeboxClient, buildFreeboxMetricReport, buildFreeboxNativeChecks } from './freebox.js';

const POLL_INTERVAL_MS = 5 * 60_000;
const NATIVE_STALE_MS = 15 * 60_000;

let pollTimer: NodeJS.Timeout | null = null;
let running = false;

export interface FreeboxPollState {
  polledAt?: Date;
  pollError?: string;
  nativeChecks?: number;
}

let lastPollState: FreeboxPollState = {};
export const freeboxPollState = () => lastPollState;

/** Load Freebox settings from database */
export async function loadFreeboxSettings(): Promise<FreeboxSettings | null> {
  return (await settings.findOne({ _id: 'freebox' })) as FreeboxSettings | null;
}

/** Default Freebox settings */
export const DEFAULT_FREEBOX_SETTINGS: FreeboxSettings = {
  _id: 'freebox',
  enabled: false,
  url: 'http://mafreebox.freebox.fr',
  appToken: '',
  appId: 'homelab-manager',
  appName: 'Homelab Manager',
  apiVersion: 4,
};

/** Ensure Freebox settings exist */
export async function ensureFreeboxSettings(): Promise<FreeboxSettings> {
  let doc = await loadFreeboxSettings();
  if (!doc) {
    doc = { ...DEFAULT_FREEBOX_SETTINGS };
    await settings.replaceOne({ _id: 'freebox' }, doc, { upsert: true });
  }
  return doc;
}

/** Get or create the Freebox equipment (source: freebox, externalId: 'freebox') */
async function getOrCreateFreeboxEquipment(): Promise<EquipmentDoc> {
  const existing = await equipments.findOne({ source: 'freebox', externalId: 'freebox' });
  if (existing) return existing;

  const sites = await loadSites();
  const siteId = sites.find((s) => s.kind === 'main')?.id;
  const doc: EquipmentDoc = {
    _id: new ObjectId(),
    name: 'Freebox',
    type: 'gateway',
    ...(siteId ? { siteId } : {}),
    source: 'freebox',
    externalId: 'freebox',
    native: { syncedAt: new Date(), checks: [] },
    createdAt: new Date(),
  };
  await equipments.insertOne(doc);
  publish('equipment', { id: doc._id.toHexString() });
  return doc;
}

/** Update Freebox equipment with native checks */
async function updateFreeboxEquipment(equipment: EquipmentDoc, checks: EquipmentNative['checks']): Promise<void> {
  const native: EquipmentNative = {
    syncedAt: new Date(),
    checks,
  };
  await equipments.updateOne(
    { _id: equipment._id },
    { $set: { native, name: 'Freebox' } }
  );
  publish('equipment', { id: equipment._id.toHexString() });
}

/** Perform a single poll of the Freebox */
export async function pollFreebox(log?: FastifyBaseLogger): Promise<FreeboxPollState> {
  if (running) {
    log?.debug('Freebox poll already running, skipping');
    return lastPollState;
  }

  const cfg = await loadFreeboxSettings();
  if (!cfg || !cfg.enabled || !cfg.appToken) {
    lastPollState = { pollError: 'Freebox non configurée ou non activée' };
    return lastPollState;
  }

  running = true;
  const startTime = Date.now();
  let pollError: string | null = null;
  let nativeChecks = 0;

  try {
    const client = createFreeboxClient(cfg);

    const [connection, system, lanBrowser, storageDisks, storageRaids, vms, wifi, callLog] = await Promise.allSettled([
      client.getConnection(),
      client.getSystem(),
      client.getLanBrowser(),
      client.getStorageDisks(),
      client.getStorageRaids(),
      client.getVMs(),
      client.getWifi(),
      client.getCallLog(),
    ]);

    const data = {
      connection: connection.status === 'fulfilled' ? connection.value : undefined,
      system: system.status === 'fulfilled' ? system.value : undefined,
      lanDevices: lanBrowser.status === 'fulfilled' ? lanBrowser.value.length : undefined,
      storageDisks: storageDisks.status === 'fulfilled' ? storageDisks.value : undefined,
      storageRaids: storageRaids.status === 'fulfilled' ? storageRaids.value : undefined,
      vms: vms.status === 'fulfilled' ? vms.value : undefined,
      wifi: wifi.status === 'fulfilled' ? wifi.value : undefined,
      callLog: callLog.status === 'fulfilled' ? callLog.value : undefined,
    };

    const failures = [
      connection, system, lanBrowser, storageDisks, storageRaids, vms, wifi, callLog
    ].filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    if (failures.length > 0) {
      const errors = failures.map((f) => f.reason?.message || 'unknown').join(', ');
      pollError = `Erreurs API: ${errors}`;
      log?.warn({ errors }, 'Freebox poll partial failure');
    }

    const checks = buildFreeboxNativeChecks(data);
    nativeChecks = checks.length;

    const equipment = await getOrCreateFreeboxEquipment();
    await updateFreeboxEquipment(equipment, checks);
    const metric = buildFreeboxMetricReport(data);
    const hasMetric =
      metric.tempC !== undefined ||
      metric.downRate !== undefined ||
      metric.upRate !== undefined ||
      metric.diskUsedPercent !== undefined ||
      metric.lanDevices !== undefined ||
      metric.vmTotal !== undefined;
    if (hasMetric) {
      await freeboxMetrics.insertOne({
        equipmentId: equipment._id,
        sampledAt: new Date(metric.checkedAt),
        report: metric,
      });
    }

    if (!cfg.deviceUid && data.connection) {
      const apiVersion = await client.getApiVersion();
      await settings.updateOne(
        { _id: 'freebox' },
        { $set: { deviceUid: apiVersion.uid, deviceType: apiVersion.device_type, polledAt: new Date(), pollError: null } }
      );
    } else {
      await settings.updateOne(
        { _id: 'freebox' },
        { $set: { polledAt: new Date(), pollError: null } }
      );
    }

    lastPollState = {
      polledAt: new Date(),
      nativeChecks,
      ...(pollError ? { pollError } : {}),
    };

    log?.info({ duration: Date.now() - startTime, checks: nativeChecks }, 'Freebox poll completed');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    pollError = msg;
    lastPollState = { pollError: msg };
    log?.error({ err }, 'Freebox poll failed');
  } finally {
    running = false;
  }

  return lastPollState;
}

/** Start the periodic Freebox poller */
export function startFreeboxPoller(log: FastifyBaseLogger): () => void {
  loadFreeboxSettings().then((cfg) => {
    if (cfg?.polledAt) {
      lastPollState = {
        polledAt: cfg.polledAt,
        pollError: cfg.pollError ?? undefined,
      };
    }
  });

  const firstPoll = setTimeout(() => {
    pollFreebox(log).catch((err) => log.error({ err }, 'Initial Freebox poll failed'));
  }, 30_000);

  pollTimer = setInterval(() => {
    pollFreebox(log).catch((err) => log.error({ err }, 'Freebox poll failed'));
  }, POLL_INTERVAL_MS);

  return () => {
    clearTimeout(firstPoll);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
}

/** Test Freebox connection with current settings */
export async function testFreeboxConnection(cfg: FreeboxSettings, log?: FastifyBaseLogger): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = createFreeboxClient(cfg);
    await client.getApiVersion();
    await client.openSession();
    await client.getConnection();
    await client.closeSession();
    return { ok: true };
  } catch (err) {
    log?.error({ err }, 'Freebox test connection failed');
    return { ok: false, error: err instanceof Error ? err.message : 'Erreur inconnue' };
  }
}

/** Start Freebox authorization flow */
export async function startFreeboxAuthorization(cfg: FreeboxSettings): Promise<{ track_id: number; app_token: string }> {
  const client = createFreeboxClient(cfg);
  return client.authorize();
}

/** Check Freebox authorization status */
export async function checkFreeboxAuthorization(cfg: FreeboxSettings, trackId: number): Promise<{ granted: boolean; status: 'unknown' | 'pending' | 'timeout' | 'granted' | 'denied'; app_token?: string }> {
  const client = createFreeboxClient(cfg);
  return client.checkAuthorization(trackId);
}

/** Save app_token after authorization */
export async function saveFreeboxAppToken(appToken: string): Promise<void> {
  await settings.updateOne(
    { _id: 'freebox' },
    { $set: { appToken, enabled: true } },
    { upsert: true }
  );
}