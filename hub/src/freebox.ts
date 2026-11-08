// Freebox OS API Client
// https://dev.freebox.fr/sdk/os/

import { createHash, createHmac } from 'node:crypto';
import type { AlertLevel, EquipmentNative, FreeboxMetricReport, FreeboxSettings } from './types.js';

// --- API Response Types ---

export interface FreeboxApiResponse<T> {
  success: boolean;
  result?: T;
  error_code?: string;
  msg?: string;
}

export interface FreeboxApiVersion {
  box_model_name: string;
  api_base_url: string;
  https_port: number;
  device_name: string;
  https_available: boolean;
  box_model: string;
  api_domain: string;
  uid: string;
  api_version: string;
  device_type: string;
}

export interface FreeboxAuthAuthorize {
  track_id: number;
  app_token: string;
  challenge: string;
  password_salt: string;
  permissions: Record<string, boolean>;
}

export interface FreeboxAuthProgress {
  // v4+ returns status; keep legacy booleans for backward compatibility
  status?: 'unknown' | 'pending' | 'timeout' | 'granted' | 'denied';
  granted?: boolean;
  pending?: boolean;
  timeout: number;
  challenge: string;
  app_token?: string;
}

export interface FreeboxSession {
  session_token: string;
  challenge: string;
  permissions: Record<string, boolean>;
}

export interface FreeboxConnection {
  status: 'up' | 'down' | 'pending';
  media: 'ftth' | 'xdsl' | '4g' | 'unknown';
  rate_up: number;
  rate_down: number;
  bandwidth_up: number;
  bandwidth_down: number;
  ipv4: string;
  ipv6: string;
  type: string;
}

export interface FreeboxSystem {
  uptime: number;
  temp1: number;
  temp2: number;
  temp3: number;
  fan1: number;
  fan2: number;
  fan3: number;
  cpu: number;
  mem: number;
  swapon: number;
  swap_total: number;
  firmware: string;
  hardware: string;
  serial: string;
  mac: string;
  box_model_name: string;
  box_model: string;
}

export interface FreeboxLanBrowser {
  interface: string;
  host_type: string;
  active: boolean;
  names: string[];
  ip: string;
  mac: string;
  reachable: boolean;
  last_time_reachable: number;
  vendor_name: string;
}

export interface FreeboxStorageDisk {
  _id: number;
  name: string;
  type: 'internal' | 'usb' | 'raid';
  size: number;
  free: number;
  used: number;
  smart: {
    smart_status: string;
    temperature: number;
    reallocated_sectors: number;
    power_on_hours: number;
  };
}

export interface FreeboxStorageRaids {
  _id: number;
  name: string;
  status: 'active' | 'degraded' | 'inactive' | 'rebuilding';
  level: string;
  devices: number;
  spare: number;
  sync_progress: number;
  size: number;
  used: number;
}

export interface FreeboxVM {
  _id: string;
  name: string;
  status: 'running' | 'stopped' | 'paused' | 'error';
  vcpu: number;
  memory: number;
  disk_size: number;
  autostart: boolean;
}

export interface FreeboxWifi {
  enabled: boolean;
  channel: number;
  ht_mode: string;
  mode: string;
  ssid: string;
  security: string;
  clients: number;
}

export interface FreeboxCallLog {
  id: string;
  type: 'incoming' | 'outgoing' | 'missed';
  number: string;
  name: string;
  duration: number;
  timestamp: number;
  is_new: boolean;
}

// --- Error Class ---

export class FreeboxError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'FreeboxError';
  }
}

// --- Freebox Client ---

export class FreeboxClient {
  private baseUrl: string;
  private apiVersion: number;
  private apiBasePath: string;
  private appId: string;
  private appName: string;
  private appToken: string | null = null;
  private sessionToken: string | null = null;

  constructor(settings: FreeboxSettings) {
    this.baseUrl = settings.url.replace(/\/+$/, '');
    this.apiVersion = settings.apiVersion;
    this.apiBasePath = `/api/v${this.apiVersion}`;
    this.appId = settings.appId;
    this.appName = settings.appName;
    this.appToken = settings.appToken || null;
  }

  private apiPath(path: string): string {
    return `${this.baseUrl}${this.apiBasePath}${path}`;
  }

  private static normalizeApiBasePath(path: string): string {
    const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
    return withLeadingSlash.replace(/\/+$/, '');
  }

  private static parseMajorApiVersion(raw: string | undefined): number | null {
    const major = Number.parseInt((raw ?? '').split('.')[0] ?? '', 10);
    return Number.isFinite(major) && major > 0 ? major : null;
  }

  private static buildApiBaseCandidates(
    version: FreeboxApiVersion,
    configuredMajor: number,
  ): string[] {
    const normalizedBase = FreeboxClient.normalizeApiBasePath(version.api_base_url || '/api');
    const rawVersion = (version.api_version ?? '').trim();
    const discoveredMajor = FreeboxClient.parseMajorApiVersion(version.api_version);
    const major = discoveredMajor ?? configuredMajor;
    const candidates = new Set<string>();

    if (/\/v\d+(\.\d+)?$/i.test(normalizedBase)) {
      candidates.add(normalizedBase);
      const compact = normalizedBase.replace(/\/v(\d+)\.\d+$/i, '/v$1');
      candidates.add(compact);
    } else {
      if (/^\d+\.\d+$/.test(rawVersion)) {
        candidates.add(`${normalizedBase}/v${rawVersion}`);
      }
      candidates.add(`${normalizedBase}/v${major}`);
      candidates.add(normalizedBase);
    }

    if (/^\d+\.\d+$/.test(rawVersion)) {
      candidates.add(`/api/v${rawVersion}`);
    }
    candidates.add(`/api/v${major}`);
    candidates.add(`/api/v${configuredMajor}`);
    return [...candidates];
  }

  private static buildApiOriginCandidates(currentBaseUrl: string, version: FreeboxApiVersion): string[] {
    const candidates = new Set<string>();
    candidates.add(currentBaseUrl.replace(/\/+$/, ''));
    try {
      const current = new URL(currentBaseUrl);
      if (version.https_port) {
        candidates.add(`https://${current.hostname}:${version.https_port}`);
      }
    } catch {
      // Ignore malformed URL and keep configured base only.
    }
    if (version.api_domain && version.https_port) {
      candidates.add(`https://${version.api_domain}:${version.https_port}`);
    }
    return [...candidates];
  }

  private async readApiVersion(): Promise<FreeboxApiVersion> {
    const url = `${this.baseUrl}/api_version`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      // @ts-expect-error - Node.js fetch supports this
      rejectUnauthorized: false,
    });
    if (!res.ok) {
      throw new FreeboxError(`Freebox API version request failed (${res.status})`, undefined, res.status);
    }
    return (await res.json()) as FreeboxApiVersion;
  }

  private static isInvalidRequest404<T>(res: Response, data: FreeboxApiResponse<T>): boolean {
    return res.status === 404
      || (!data.success && (
        data.msg?.includes('(404)')
        || data.msg?.includes('Version d’API inconnue')
        || data.msg?.includes("Version d'API inconnue")
        || data.error_code === 'invalid_request'
        || data.error_code === 'unknown_api_version'
      ));
  }

  private async requestOnce<T>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>
  ): Promise<{ res: Response; data: FreeboxApiResponse<T> }> {
    const url = this.apiPath(path);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        // @ts-expect-error - Node.js fetch supports this
        rejectUnauthorized: false,
      });
      const data = (await res.json()) as FreeboxApiResponse<T>;
      return { res, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new FreeboxError(`Freebox request failed (${method} ${url}): ${msg}`);
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    authenticated = false
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authenticated && this.sessionToken) {
      headers['X-Fbx-App-Auth'] = this.sessionToken;
    }

    const attemptRequest = async (): Promise<{ res: Response; data: FreeboxApiResponse<T> } | null> => {
      try {
        return await this.requestOnce<T>(method, path, body, headers);
      } catch {
        return null;
      }
    };

    let attempt = await attemptRequest();
    if (!attempt) throw new FreeboxError(`Freebox request failed (${method} ${this.apiPath(path)}): fetch failed`);
    let { res, data } = attempt;

    if (FreeboxClient.isInvalidRequest404(res, data)) {
      const version = await this.readApiVersion();
      const previousBase = this.apiBasePath;
      const previousUrl = this.baseUrl;
      const originCandidates = FreeboxClient.buildApiOriginCandidates(previousUrl, version);
      const candidates = FreeboxClient.buildApiBaseCandidates(version, this.apiVersion);
      let retried = false;
      let gotResponse = false;
      for (const origin of originCandidates) {
        for (const candidate of candidates) {
          if (origin === previousUrl && candidate === previousBase) continue;
          this.baseUrl = origin;
          this.apiBasePath = candidate;
          attempt = await attemptRequest();
          if (!attempt) continue;
          ({ res, data } = attempt);
          gotResponse = true;
          retried = true;
          if (!FreeboxClient.isInvalidRequest404(res, data)) break;
        }
        if (!FreeboxClient.isInvalidRequest404(res, data)) break;
      }
      if (!retried) {
        attempt = await attemptRequest();
        if (!attempt) throw new FreeboxError(`Freebox request failed (${method} ${this.apiPath(path)}): fetch failed`);
        ({ res, data } = attempt);
        gotResponse = true;
      }
      if (!gotResponse && FreeboxClient.isInvalidRequest404(res, data)) {
        throw new FreeboxError(`Freebox request failed (${method} ${this.apiPath(path)}): fetch failed`);
      }
    }

    if (!data.success) {
      throw new FreeboxError(
        data.msg || `Freebox API error: ${data.error_code}`,
        data.error_code,
        res.status
      );
    }

    return data.result as T;
  }

  // --- Authentication ---

  /** Step 1: Request authorization (returns track_id) */
  async authorize(): Promise<{ track_id: number; app_token: string }> {
    const result = await this.request<FreeboxAuthAuthorize>('POST', '/login/authorize/', {
      app_id: this.appId,
      app_name: this.appName,
      app_version: '1.0.0',
      device_name: 'Homelab Manager',
    });
    return { track_id: result.track_id, app_token: result.app_token };
  }

  /** Step 2: Poll for authorization result (user must approve on Freebox screen) */
  async checkAuthorization(trackId: number): Promise<{ granted: boolean; status: 'unknown' | 'pending' | 'timeout' | 'granted' | 'denied'; app_token?: string }> {
    const result = await this.request<FreeboxAuthProgress>('GET', `/login/authorize/${trackId}`);
    const status = result.status ?? (result.granted ? 'granted' : 'pending');
    const granted = status === 'granted' || result.granted === true;
    if (granted && result.app_token) {
      this.appToken = result.app_token;
    }
    return { granted, status, app_token: result.app_token };
  }

  /** Step 3: Open session (get session token) */
  async openSession(): Promise<string> {
    if (!this.appToken) {
      throw new FreeboxError('No app token available. Run authorize() first.');
    }

    // Get challenge
    const { challenge } = await this.request<{ challenge: string }>('GET', '/login/');

    // Compute password = HMAC-SHA1(app_token, challenge)
    const password = createHmac('sha1', this.appToken).update(challenge).digest('hex');

    // Open session
    const session = await this.request<FreeboxSession>('POST', '/login/session/', {
      app_id: this.appId,
      password,
    });

    this.sessionToken = session.session_token;
    return this.sessionToken;
  }

  /** Close session */
  async closeSession(): Promise<void> {
    if (this.sessionToken) {
      await this.request('POST', '/login/logout/', null, true);
      this.sessionToken = null;
    }
  }

  /** Ensure we have a valid session */
  private async ensureSession(): Promise<void> {
    if (!this.sessionToken) {
      await this.openSession();
    }
  }

  // --- API Endpoints ---

  /** Get API version info (no auth needed) */
  async getApiVersion(): Promise<FreeboxApiVersion> {
    return this.readApiVersion();
  }

  /** Get connection status (internet) */
  async getConnection(): Promise<FreeboxConnection> {
    await this.ensureSession();
    return this.request<FreeboxConnection>('GET', '/connection/', null, true);
  }

  /** Get system info (uptime, temps, fans, CPU, memory) */
  async getSystem(): Promise<FreeboxSystem> {
    await this.ensureSession();
    return this.request<FreeboxSystem>('GET', '/system/', null, true);
  }

  /** Get LAN browser (connected devices) */
  async getLanBrowser(): Promise<FreeboxLanBrowser[]> {
    await this.ensureSession();
    return this.request<FreeboxLanBrowser[]>('GET', '/lan/browser/', null, true);
  }

  /** Get storage disks */
  async getStorageDisks(): Promise<FreeboxStorageDisk[]> {
    await this.ensureSession();
    return this.request<FreeboxStorageDisk[]>('GET', '/storage/disk/', null, true);
  }

  /** Get RAID arrays */
  async getStorageRaids(): Promise<FreeboxStorageRaids[]> {
    await this.ensureSession();
    return this.request<FreeboxStorageRaids[]>('GET', '/storage/raid/', null, true);
  }

  /** Get VMs (Freebox Delta/Pop only) */
  async getVMs(): Promise<FreeboxVM[]> {
    await this.ensureSession();
    try {
      return await this.request<FreeboxVM[]>('GET', '/vm/', null, true);
    } catch (err) {
      // VM API may not be available on all models
      if (err instanceof FreeboxError && err.errorCode === 'not_found') {
        return [];
      }
      throw err;
    }
  }

  /** Get WiFi status */
  async getWifi(): Promise<FreeboxWifi[]> {
    await this.ensureSession();
    return this.request<FreeboxWifi[]>('GET', '/wifi/', null, true);
  }

  /** Get call log (last 50) */
  async getCallLog(): Promise<FreeboxCallLog[]> {
    await this.ensureSession();
    return this.request<FreeboxCallLog[]>('GET', '/call/log/?limit=50', null, true);
  }
}

// --- Discovery Helper ---

/** Discover Freebox on local network via mDNS or HTTP fallback */
export async function discoverFreebox(): Promise<FreeboxApiVersion | null> {
  try {
    const res = await fetch('http://mafreebox.freebox.fr/api_version', {
      // @ts-expect-error
      rejectUnauthorized: false,
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Ignore
  }
  return null;
}

/** Create client from settings */
export function createFreeboxClient(settings: FreeboxSettings): FreeboxClient {
  return new FreeboxClient(settings);
}

// --- Native checks ---

/** The data one poll of the Freebox gathers (each endpoint may have failed) */
export interface FreeboxPollData {
  connection?: FreeboxConnection;
  system?: FreeboxSystem;
  lanDevices?: number;
  storageDisks?: FreeboxStorageDisk[];
  storageRaids?: FreeboxStorageRaids[];
  vms?: FreeboxVM[];
  wifi?: FreeboxWifi[];
  callLog?: FreeboxCallLog[];
}

/** Time-series sample for Freebox charts (equipment detail). */
export function buildFreeboxMetricReport(data: FreeboxPollData, checkedAt = Date.now()): FreeboxMetricReport {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  const readNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const pickNumber = (obj: Record<string, unknown> | null, keys: string[]): number | null => {
    if (!obj) return null;
    for (const key of keys) {
      const v = readNumber(obj[key]);
      if (v !== null) return v;
    }
    return null;
  };

  const report: FreeboxMetricReport = { checkedAt };
  const connection = asRecord(data.connection);
  const downRate = pickNumber(connection, ['rate_down', 'bandwidth_down']) ?? pickNumber(asRecord(connection?.down), ['rate', 'maxrate']);
  const upRate = pickNumber(connection, ['rate_up', 'bandwidth_up']) ?? pickNumber(asRecord(connection?.up), ['rate', 'maxrate']);
  if (downRate !== null) report.downRate = downRate;
  if (upRate !== null) report.upRate = upRate;

  const system = asRecord(data.system);
  const temperatures = [
    pickNumber(system, ['temp1']),
    pickNumber(system, ['temp2']),
    pickNumber(system, ['temp3']),
    pickNumber(system, ['temp_cpum']),
    pickNumber(system, ['temp_cpub']),
    pickNumber(system, ['temp_sw']),
  ].filter((v): v is number => v !== null);
  if (temperatures.length > 0) report.tempC = Math.max(...temperatures);

  if (data.lanDevices !== undefined) report.lanDevices = data.lanDevices;

  if (data.vms) {
    const vms = data.vms.map(asRecord).filter((vm): vm is Record<string, unknown> => vm !== null);
    report.vmTotal = vms.length;
    report.vmRunning = vms.filter((vm) => {
      const s = vm.status ?? vm.state;
      return typeof s === 'string' && ['running', 'started', 'up'].includes(s.toLowerCase());
    }).length;
  }

  const disks = data.storageDisks ?? [];
  let total = 0;
  let used = 0;
  for (const disk of disks) {
    const d = asRecord(disk);
    const totalBytes = pickNumber(d, ['total_bytes', 'size']);
    const freeBytes = pickNumber(d, ['free_bytes', 'free']);
    const usedBytes = pickNumber(d, ['used_bytes', 'used']);
    const partitions = Array.isArray(d?.partitions) ? d.partitions.map(asRecord).filter((p): p is Record<string, unknown> => p !== null) : [];
    const partTotal = partitions.reduce((sum, p) => sum + (pickNumber(p, ['total_bytes']) ?? 0), 0);
    const partUsed = partitions.reduce((sum, p) => sum + (pickNumber(p, ['used_bytes']) ?? 0), 0);
    const resolvedTotal = totalBytes ?? (partTotal > 0 ? partTotal : null);
    const resolvedUsed = usedBytes ?? (resolvedTotal !== null && freeBytes !== null ? resolvedTotal - freeBytes : null) ?? (partUsed > 0 ? partUsed : null);
    if (resolvedTotal !== null && resolvedTotal > 0 && resolvedUsed !== null && resolvedUsed >= 0) {
      total += resolvedTotal;
      used += resolvedUsed;
    }
  }
  if (total > 0) {
    report.diskTotalBytes = total;
    report.diskUsedBytes = used;
    report.diskUsedPercent = (used / total) * 100;
  }

  return report;
}

// Load of the box: warn from 85 %, alert from 95 % (same thresholds as the Omada devices).
const LOAD_WARN = 85;
const LOAD_ALERT = 95;
const loadLevel = (pct: number): AlertLevel => (pct >= LOAD_ALERT ? 'alert' : pct >= LOAD_WARN ? 'warn' : 'ok');
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

type Check = EquipmentNative['checks'][number];
const check = (key: string, label: string, level: AlertLevel, reason?: string): Check =>
  ({ key, label, level, ...(level !== 'ok' ? { reason: reason ?? label } : {}) });

/** The native checks of the Freebox from the data of one poll */
export function buildFreeboxNativeChecks(data: FreeboxPollData): EquipmentNative['checks'] {
  const checks: Check[] = [];
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  const readString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value : null;
  const readNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const pickString = (obj: Record<string, unknown> | null, keys: string[]): string | null => {
    if (!obj) return null;
    for (const key of keys) {
      const v = readString(obj[key]);
      if (v) return v;
    }
    return null;
  };
  const pickNumber = (obj: Record<string, unknown> | null, keys: string[]): number | null => {
    if (!obj) return null;
    for (const key of keys) {
      const v = readNumber(obj[key]);
      if (v !== null) return v;
    }
    return null;
  };

  if (data.connection) {
    const connection = asRecord(data.connection);
    const nested = asRecord(connection?.status);
    const status = pickString(connection, ['status'])
      ?? pickString(nested, ['status'])
      ?? pickString(connection, ['state'])
      ?? pickString(nested, ['state'])
      ?? 'unknown';
    const medium = pickString(connection, ['type', 'media'])
      ?? pickString(nested, ['protocol', 'modulation'])
      ?? 'inconnu';
    const downRate = pickNumber(connection, ['rate_down', 'bandwidth_down'])
      ?? pickNumber(asRecord(connection?.down), ['rate', 'maxrate']);
    const upRate = pickNumber(connection, ['rate_up', 'bandwidth_up'])
      ?? pickNumber(asRecord(connection?.up), ['rate', 'maxrate']);
    const upStates = new Set(['up', 'showtime', 'connected', 'active', 'ok']);
    const downStates = new Set(['down', 'disconnected', 'error', 'failed']);
    const normalizedStatus = status.toLowerCase();
    const hasTraffic = (downRate ?? 0) > 0 || (upRate ?? 0) > 0;
    const isUp = upStates.has(normalizedStatus) || (!downStates.has(normalizedStatus) && hasTraffic);
    const statusReason = `Statut ${status} (${medium})`;
    checks.push(check('connection', 'Connexion Internet', isUp ? 'ok' : 'alert', isUp ? undefined : statusReason));
    if (downRate !== null || upRate !== null) {
      checks.push({
        key: 'connection-rate',
        label: `Débit descendant ${downRate !== null ? downRate : 0} · montant ${upRate !== null ? upRate : 0}`,
        level: 'ok',
      });
    }
  }

  if (data.system) {
    const system = asRecord(data.system);
    const cpu = pickNumber(system, ['cpu']);
    if (cpu !== null) {
      const cpuLevel = loadLevel(cpu);
      checks.push(check('cpu', 'Processeur', cpuLevel, `Processeur à ${cpu} %`));
    }

    const mem = pickNumber(system, ['mem']);
    if (mem !== null) {
      const memLevel = loadLevel(mem);
      checks.push(check('memory', 'Mémoire', memLevel, `Mémoire à ${mem} %`));
    }

    const temperatures = [
      pickNumber(system, ['temp1']),
      pickNumber(system, ['temp2']),
      pickNumber(system, ['temp3']),
      pickNumber(system, ['temp_cpum']),
      pickNumber(system, ['temp_cpub']),
      pickNumber(system, ['temp_sw']),
    ].filter((v): v is number => v !== null);
    if (temperatures.length > 0) {
      const temp = Math.max(...temperatures);
      const tempLevel: AlertLevel = temp >= 80 ? 'alert' : temp >= 70 ? 'warn' : 'ok';
      checks.push(check('temperature', 'Température', tempLevel, `Température à ${temp} °C`));
    }

    const firmware = pickString(system, ['firmware', 'firmware_version']);
    if (firmware) {
      checks.push({ key: 'firmware', label: `Firmware ${firmware}`, level: 'ok' });
    }

    const uptime = pickNumber(system, ['uptime', 'uptime_val']);
    if (uptime !== null) {
      checks.push({ key: 'uptime', label: `Uptime ${Math.floor(uptime / 3600)} h`, level: 'ok' });
    }
  }

  if (data.lanDevices !== undefined) {
    checks.push({ key: 'lan-devices', label: `${data.lanDevices} appareil(s) connecté(s)`, level: 'ok' });
  }

  for (const disk of data.storageDisks ?? []) {
    const d = asRecord(disk);
    const diskId = pickString(d, ['_id', 'id', 'serial']) ?? String(d?._id ?? d?.id ?? 'unknown');
    const diskName = pickString(d, ['name', 'model']) ?? diskId;
    const smart = pickString(asRecord(d?.smart), ['smart_status']);
    const state = pickString(d, ['state']);
    let level: AlertLevel = 'ok';
    let reason: string | undefined;
    if (smart) {
      level = smart === 'good' || smart === 'ok' ? 'ok' : 'alert';
      reason = level === 'ok' ? undefined : `SMART: ${smart}`;
    } else if (state) {
      const okStates = new Set(['enabled', 'active', 'mounted']);
      level = okStates.has(state.toLowerCase()) ? 'ok' : 'warn';
      reason = level === 'ok' ? undefined : `Statut ${state}`;
    }
    checks.push(check(`disk:${diskId}`, `Disque ${diskName}`, level, reason));

    const totalBytes = pickNumber(d, ['total_bytes', 'size']);
    const freeBytes = pickNumber(d, ['free_bytes', 'free']);
    const usedBytesDirect = pickNumber(d, ['used_bytes', 'used']);
    const partitions = Array.isArray(d?.partitions) ? d.partitions.map(asRecord).filter((p): p is Record<string, unknown> => p !== null) : [];
    const partTotal = partitions.reduce((sum, p) => sum + (pickNumber(p, ['total_bytes']) ?? 0), 0);
    const partUsed = partitions.reduce((sum, p) => sum + (pickNumber(p, ['used_bytes']) ?? 0), 0);
    const resolvedTotal = totalBytes ?? (partTotal > 0 ? partTotal : null);
    const resolvedUsed = usedBytesDirect ?? (resolvedTotal !== null && freeBytes !== null ? resolvedTotal - freeBytes : null) ?? (partUsed > 0 ? partUsed : null);
    if (resolvedTotal !== null && resolvedTotal > 0 && resolvedUsed !== null && resolvedUsed >= 0) {
      const pct = (resolvedUsed / resolvedTotal) * 100;
      const usageLevel: AlertLevel = pct >= 95 ? 'alert' : pct >= 85 ? 'warn' : 'ok';
      checks.push(check(
        `disk-usage:${diskId}`,
        `Espace ${diskName}`,
        usageLevel,
        `${pct.toFixed(1)}% utilisé (${formatBytes(resolvedUsed)}/${formatBytes(resolvedTotal)})`,
      ));
    }
  }

  for (const raid of data.storageRaids ?? []) {
    const r = asRecord(raid);
    const raidId = pickString(r, ['_id', 'id', 'name']) ?? String(r?._id ?? r?.id ?? 'unknown');
    const raidName = pickString(r, ['name']) ?? raidId;
    const raidStatus = pickString(r, ['status']) ?? 'unknown';
    const level: AlertLevel = raidStatus === 'active' ? 'ok' : raidStatus === 'degraded' ? 'alert' : 'warn';
    checks.push(check(`raid:${raidId}`, `RAID ${raidName}`, level, raidStatus !== 'active' ? `Statut ${raidStatus}` : undefined));
  }

  for (const vm of data.vms ?? []) {
    const v = asRecord(vm);
    const vmId = pickString(v, ['_id', 'id', 'vmid', 'name']) ?? String(v?._id ?? v?.id ?? v?.vmid ?? 'unknown');
    const vmName = pickString(v, ['name']) ?? vmId;
    const vmStatus = pickString(v, ['status', 'state']) ?? 'unknown';
    const runningStates = new Set(['running', 'started', 'up']);
    const errorStates = new Set(['error', 'failed']);
    const level: AlertLevel = runningStates.has(vmStatus) ? 'ok' : errorStates.has(vmStatus) ? 'alert' : 'warn';
    checks.push(check(`vm:${vmId}`, `VM ${vmName}`, level, !runningStates.has(vmStatus) ? `Statut ${vmStatus}` : undefined));
  }

  if (data.wifi) {
    const enabled = data.wifi.some((w) => w.enabled);
    checks.push(check('wifi', 'WiFi', enabled ? 'ok' : 'warn', enabled ? undefined : 'WiFi désactivé'));
  }

  const missed = (data.callLog ?? []).filter((c) => c.type === 'missed' && c.is_new).length;
  if (missed > 0) {
    checks.push(check('calls', 'Appels manqués', 'warn', `${missed} appel(s) manqué(s) non lu(s)`));
  }

  return checks;
}