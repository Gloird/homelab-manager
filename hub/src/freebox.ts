// Freebox OS API Client
// https://dev.freebox.fr/sdk/os/

import { createHash, createHmac } from 'node:crypto';
import type { AlertLevel, EquipmentNative, FreeboxSettings } from './types.js';

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
  granted: boolean;
  pending: boolean;
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
  private appId: string;
  private appName: string;
  private appToken: string | null = null;
  private sessionToken: string | null = null;

  constructor(settings: FreeboxSettings) {
    this.baseUrl = settings.url.replace(/\/+$/, '');
    this.apiVersion = settings.apiVersion;
    this.appId = settings.appId;
    this.appName = settings.appName;
    this.appToken = settings.appToken || null;
  }

  private apiPath(path: string): string {
    return `${this.baseUrl}/api/v${this.apiVersion}${path}`;
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

    const res = await fetch(this.apiPath(path), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // @ts-expect-error - Node.js fetch supports this
      rejectUnauthorized: false,
    });

    const data: FreeboxApiResponse<T> = await res.json();

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
  async checkAuthorization(trackId: number): Promise<{ granted: boolean; app_token?: string }> {
    const result = await this.request<FreeboxAuthProgress>('GET', `/login/authorize/${trackId}`);
    if (result.granted && result.app_token) {
      this.appToken = result.app_token;
    }
    return { granted: result.granted, app_token: result.app_token };
  }

  /** Step 3: Open session (get session token) */
  async openSession(): Promise<string> {
    if (!this.appToken) {
      throw new FreeboxError('No app token available. Run authorize() first.');
    }

    // Get challenge
    const { challenge } = await this.request<{ challenge: string }>('GET', '/login/session/');

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
    return this.request<FreeboxApiVersion>('GET', '/api_version');
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

// Load of the box: warn from 85 %, alert from 95 % (same thresholds as the Omada devices).
const LOAD_WARN = 85;
const LOAD_ALERT = 95;
const loadLevel = (pct: number): AlertLevel => (pct >= LOAD_ALERT ? 'alert' : pct >= LOAD_WARN ? 'warn' : 'ok');

type Check = EquipmentNative['checks'][number];
const check = (key: string, label: string, level: AlertLevel, reason?: string): Check =>
  ({ key, label, level, ...(level !== 'ok' ? { reason: reason ?? label } : {}) });

/** The native checks of the Freebox from the data of one poll */
export function buildFreeboxNativeChecks(data: FreeboxPollData): EquipmentNative['checks'] {
  const checks: Check[] = [];

  if (data.connection) {
    const up = data.connection.status === 'up';
    checks.push(check('connection', 'Connexion Internet', up ? 'ok' : 'alert', up ? undefined : `Statut ${data.connection.status} (${data.connection.type || data.connection.media})`));
  }

  if (data.system) {
    const s = data.system;
    const cpuLevel = loadLevel(s.cpu);
    checks.push(check('cpu', 'Processeur', cpuLevel, `Processeur à ${s.cpu} %`));
    const memLevel = loadLevel(s.mem);
    checks.push(check('memory', 'Mémoire', memLevel, `Mémoire à ${s.mem} %`));
    const temp = Math.max(s.temp1, s.temp2, s.temp3);
    const tempLevel: AlertLevel = temp >= 80 ? 'alert' : temp >= 70 ? 'warn' : 'ok';
    checks.push(check('temperature', 'Température', tempLevel, `Température à ${temp} °C`));
    checks.push({ key: 'firmware', label: `Firmware ${s.firmware}`, level: 'ok' });
  }

  if (data.lanDevices !== undefined) {
    checks.push({ key: 'lan-devices', label: `${data.lanDevices} appareil(s) connecté(s)`, level: 'ok' });
  }

  for (const disk of data.storageDisks ?? []) {
    const smart = disk.smart?.smart_status;
    const level: AlertLevel = smart === 'good' ? 'ok' : 'alert';
    checks.push(check(`disk:${disk._id}`, `Disque ${disk.name}`, level, smart && smart !== 'good' ? `SMART: ${smart}` : undefined));
  }

  for (const raid of data.storageRaids ?? []) {
    const level: AlertLevel = raid.status === 'active' ? 'ok' : raid.status === 'degraded' ? 'alert' : 'warn';
    checks.push(check(`raid:${raid._id}`, `RAID ${raid.name}`, level, raid.status !== 'active' ? `Statut ${raid.status}` : undefined));
  }

  for (const vm of data.vms ?? []) {
    const level: AlertLevel = vm.status === 'running' ? 'ok' : vm.status === 'error' ? 'alert' : 'warn';
    checks.push(check(`vm:${vm._id}`, `VM ${vm.name}`, level, vm.status !== 'running' ? `Statut ${vm.status}` : undefined));
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