import type { FastifyInstance, FastifyRequest } from 'fastify';
import { settings } from '../db.js';
import { testConnection, type HomeAssistantBridge } from '../homeassistant/bridge.js';
import { AGENT_TARGETS, agentBinary } from '../agentBinaries.js';
import { loadAgentSettings, maybeAutoUpdate } from '../agentUpdate.js';
import { hosts } from '../db.js';
import { SAFE_URL, TAILSCALE_HOST, agentCommands } from '../hubUrl.js';
import { loadPki } from '../pkiStore.js';
import type { HaDetail, HaHostDetail, HomeAssistantSettings } from '../types.js';
import { DEFAULT_DETAIL, HA_PRESETS, HA_SECTIONS, haLevelSchema, normalizeDetail, normalizeHostDetail } from '../homeassistant/detail.js';
import { loadMqttBrokers } from '../probes.js';
import { ROLE_ID_RE } from '../roles.js';
import type { MqttBroker } from '../types.js';

const DEFAULTS: HomeAssistantSettings = {
  _id: 'homeassistant',
  enabled: false,
  broker: '',
  username: '',
  password: '',
  topic: 'homelab-manager',
  discoveryPrefix: 'homeassistant',
  publicUrl: '',
  detail: DEFAULT_DETAIL,
};

export async function loadHomeAssistantSettings() {
  const stored = (await settings.findOne({ _id: 'homeassistant' })) as HomeAssistantSettings | null;
  return { ...DEFAULTS, ...stored, detail: normalizeDetail(stored?.detail) };
}

// What the bridge connects with: the address and account of its broker role ('' when the role is gone or its host has
// no address yet), else the broker typed before the roles.
export async function loadHaBridgeSettings(): Promise<HomeAssistantSettings> {
  const s = await loadHomeAssistantSettings();
  if (!s.brokerRoleId) return s;
  const b = (await loadMqttBrokers()).brokers.find((x) => x.id === s.brokerRoleId);
  return { ...s, broker: b?.url ?? '', username: b?.username ?? '', password: b?.password ?? '' };
}

// The broker role that is the broker typed before the roles: same address and account.
export function matchHaBroker(brokers: MqttBroker[], s: Pick<HomeAssistantSettings, 'broker' | 'username' | 'password'>) {
  const url = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
  return brokers.find((b) => b.url && url(b.url) === url(s.broker) && b.username === s.username && b.password === s.password) ?? null;
}

// The bridge publishes to a broker role: the broker typed before the roles is linked to the role that matches it,
// else kept (and shown to be linked by hand) so that the publication goes on.
export async function migrateHaBroker() {
  const s = (await settings.findOne({ _id: 'homeassistant' })) as HomeAssistantSettings | null;
  if (!s || s.brokerRoleId || !s.broker) return;
  const role = matchHaBroker((await loadMqttBrokers()).brokers, s);
  if (role) await settings.updateOne({ _id: 'homeassistant' }, { $set: { brokerRoleId: role.id, broker: '', username: '', password: '' } });
}

// the account is the one of the role, never sent; legacyBroker: broker typed before the roles, not linked to one yet
function dto(s: HomeAssistantSettings, bridge: HomeAssistantBridge) {
  const { password: _password, username: _username, broker, _id, brokerRoleId, ...rest } = s;
  // presets: sections of each level, for the custom picker
  return { ...rest, brokerRoleId: brokerRoleId ?? null, legacyBroker: brokerRoleId ? null : broker || null, presets: HA_PRESETS, status: bridge.status() };
}

interface Body {
  enabled: boolean;
  brokerRoleId?: string; // absent: unchanged, "": none (the broker typed before the roles is dropped once one is given)
  topic: string;
  discoveryPrefix: string;
  publicUrl?: string;
  detail?: HaDetail;
}

const detailBody = {
  type: 'object',
  required: ['level'],
  additionalProperties: false,
  properties: {
    level: { enum: [...Object.keys(HA_PRESETS), 'custom'] },
    sections: { type: 'array', items: { enum: [...HA_SECTIONS] }, maxItems: HA_SECTIONS.length },
  },
} as const;

const TOPIC = '^[A-Za-z0-9_\\-]+(/[A-Za-z0-9_\\-]+)*$';
const body = {
  type: 'object',
  required: ['enabled', 'topic', 'discoveryPrefix'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    brokerRoleId: { type: 'string', maxLength: 32, pattern: `^(|${ROLE_ID_RE.source.slice(1, -1)})$` },
    topic: { type: 'string', minLength: 1, maxLength: 64, pattern: TOPIC },
    discoveryPrefix: { type: 'string', minLength: 1, maxLength: 64, pattern: TOPIC },
    publicUrl: { type: 'string', maxLength: 256 },
    detail: detailBody,
  },
} as const;

export function registerSettingsRoutes(app: FastifyInstance, bridge: HomeAssistantBridge) {
  app.get('/api/settings/homeassistant', async () => dto(await loadHomeAssistantSettings(), bridge));

  app.put<{ Body: Body }>('/api/settings/homeassistant', { schema: { body } }, async (req, reply) => {
    const current = await loadHomeAssistantSettings();
    const { brokerRoleId, ...rest } = req.body;
    const next: HomeAssistantSettings = {
      ...current,
      ...rest,
      // a role chosen (or none) replaces the broker typed before the roles
      ...(brokerRoleId === undefined ? {} : { brokerRoleId: brokerRoleId || undefined, broker: '', username: '', password: '' }),
      detail: normalizeDetail(req.body.detail ?? current.detail),
      _id: 'homeassistant',
    };
    if (!next.brokerRoleId) delete next.brokerRoleId;
    next.publicUrl = next.publicUrl.trim().replace(/\/+$/, '');
    if (next.publicUrl && !SAFE_URL.test(next.publicUrl)) return reply.code(400).send({ error: "URL de l'interface invalide (http(s)://hôte[:port][/chemin])" });
    if (next.brokerRoleId && !(await loadMqttBrokers()).brokers.some((b) => b.id === next.brokerRoleId)) return reply.code(400).send({ error: 'broker MQTT inconnu' });
    if (next.enabled && !next.brokerRoleId && !next.broker) return reply.code(400).send({ error: 'choisir un broker MQTT' });
    await settings.replaceOne({ _id: 'homeassistant' }, next, { upsert: true });
    await bridge.apply(await loadHaBridgeSettings());
    return dto(next, bridge);
  });

  // entities that a level of detail would publish, for the settings page
  app.post<{ Body: { detail?: HaDetail; hosts?: { ids: string[]; haDetail?: HaHostDetail | null } } }>(
    '/api/settings/homeassistant/preview',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            detail: detailBody,
            // only these hosts, with this level for them when given (host options, group edit)
            hosts: {
              type: 'object',
              required: ['ids'],
              additionalProperties: false,
              properties: { ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', maxLength: 24 } }, haDetail: haLevelSchema },
            },
          },
        },
      },
    },
    async (req) => {
      const s = await loadHomeAssistantSettings();
      const scope = req.body.hosts && { ids: req.body.hosts.ids, haDetail: req.body.hosts.haDetail === undefined ? undefined : normalizeHostDetail(req.body.hosts.haDetail) };
      return bridge.preview(req.body.detail ? normalizeDetail(req.body.detail) : s.detail, s, scope);
    },
  );

  app.post('/api/settings/homeassistant/republish', async (_req, reply) => {
    if (!bridge.republish()) return reply.code(409).send({ error: "l'intégration n'est pas connectée au broker" });
    return { ok: true };
  });

  // connection test with the address and account of a broker role
  app.post<{ Body: { brokerRoleId: string } }>(
    '/api/settings/homeassistant/test',
    { schema: { body: { type: 'object', required: ['brokerRoleId'], additionalProperties: false, properties: { brokerRoleId: body.properties.brokerRoleId } } } },
    async (req, reply) => {
      const b = (await loadMqttBrokers()).brokers.find((x) => x.id === req.body.brokerRoleId);
      if (!b) return reply.code(400).send({ error: 'broker MQTT inconnu' });
      if (!b.url) return { ok: false, error: "adresse de l'hôte du broker inconnue" };
      try {
        await testConnection(b.url, b.username, b.password);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}

// Agents: automatic update, hub URL, apt-get update interval and the binaries the hub distributes.
interface AgentBody {
  autoUpdate?: boolean;
  hubUrl?: string;
  checkIntervalHours?: number;
  agentPort?: number;
  tailscaleHub?: string;
}

const agentBody = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    autoUpdate: { type: 'boolean' },
    hubUrl: { type: 'string', maxLength: 256 },
    checkIntervalHours: { type: 'integer', minimum: 0, maximum: 720 },
    agentPort: { type: 'integer', minimum: 1, maximum: 65535 },
    tailscaleHub: { type: 'string', maxLength: 253 },
  },
} as const;

export function registerAgentSettingsRoutes(app: FastifyInstance, bridge: HomeAssistantBridge) {
  const dto = async (req: FastifyRequest) => {
    const { _id, ...s } = await loadAgentSettings();
    const pki = await loadPki();
    const cmd = await agentCommands(req);
    return {
      ...s,
      binaries: AGENT_TARGETS.map((t) => agentBinary(t.arch, t.os)).filter((b) => b !== null),
      // what an admin needs to check the pinned certificates by hand
      tls: {
        agentUrl: cmd?.url ?? null,
        serverPin: pki.serverPin,
        caFingerprint: pki.caFingerprint,
        upgradeCommand: cmd?.upgrade ?? null,
        uninstallCommand: cmd?.uninstall ?? null,
      },
    };
  };

  app.get('/api/settings/agents', (req) => dto(req));

  app.put<{ Body: AgentBody }>('/api/settings/agents', { schema: { body: agentBody } }, async (req, reply) => {
    const current = await loadAgentSettings();
    const next = { ...current, ...req.body };
    next.hubUrl = next.hubUrl.trim().replace(/\/+$/, '');
    if (next.hubUrl && !SAFE_URL.test(next.hubUrl)) return reply.code(400).send({ error: 'URL du hub invalide (http(s)://hôte[:port][/chemin])' });
    next.tailscaleHub = next.tailscaleHub.trim();
    if (next.tailscaleHub && !TAILSCALE_HOST.test(next.tailscaleHub)) return reply.code(400).send({ error: 'adresse Tailscale invalide (nom d\'hôte ou IP, sans http:// ni port)' });
    await settings.replaceOne({ _id: 'agents' }, next, { upsert: true });
    if (next.hubUrl !== current.hubUrl) bridge.refresh();
    if (next.autoUpdate && !current.autoUpdate) {
      for (const h of await hosts.find({}, { projection: { _id: 1 } }).toArray()) await maybeAutoUpdate(h._id);
    }
    return dto(req);
  });
}

// Freebox OS: settings, authorization, test
import { loadFreeboxSettings, ensureFreeboxSettings, DEFAULT_FREEBOX_SETTINGS } from '../freeboxSync.js';
import { testFreeboxConnection, startFreeboxAuthorization, checkFreeboxAuthorization, saveFreeboxAppToken } from '../freeboxSync.js';
import type { FreeboxSettings } from '../types.js';

const freeboxBody = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    url: { type: 'string', maxLength: 256 },
    appId: { type: 'string', maxLength: 64 },
    appName: { type: 'string', maxLength: 64 },
    apiVersion: { type: 'integer', minimum: 1, maximum: 10 },
  },
} as const;

function freeboxDto(s: FreeboxSettings) {
  const { appToken: _appToken, _id, ...rest } = s;
  return {
    ...rest,
    // Don't expose appToken, only whether the app is authorized
    appToken: s.appToken ? '***' : null,
    // Add poll state
    polledAt: s.polledAt ?? null,
    pollError: s.pollError ?? null,
  };
}

export function registerFreeboxSettingsRoutes(app: FastifyInstance) {
  app.get('/api/settings/freebox', async () => {
    const s = await loadFreeboxSettings();
    return s ? freeboxDto(s) : { ...DEFAULT_FREEBOX_SETTINGS, appToken: null, polledAt: null, pollError: null };
  });

  app.put<{ Body: Partial<FreeboxSettings> }>('/api/settings/freebox', { schema: { body: freeboxBody } }, async (req, reply) => {
    const current = await ensureFreeboxSettings();
    const next = { ...current, ...req.body };
    if (next.url) next.url = next.url.trim().replace(/\/+$/, '');
    if (next.appId) next.appId = next.appId.trim();
    if (next.appName) next.appName = next.appName.trim();
    await settings.replaceOne({ _id: 'freebox' }, next, { upsert: true });
    return freeboxDto(next);
  });

  // Test connection
  app.post('/api/settings/freebox/test', async (req, reply) => {
    const cfg = await loadFreeboxSettings();
    if (!cfg) return reply.code(400).send({ ok: false, error: 'Freebox non configurée' });
    return testFreeboxConnection(cfg);
  });

  // Start authorization (step 1)
  app.post('/api/settings/freebox/authorize', async (req, reply) => {
    const cfg = await ensureFreeboxSettings();
    try {
      const { track_id, app_token } = await startFreeboxAuthorization(cfg);
      return { track_id, app_token };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'Erreur autorisation' });
    }
  });

  // Check authorization (step 2 - poll)
  app.post<{ Body: { track_id: number } }>('/api/settings/freebox/authorize/check', { schema: { body: { type: 'object', required: ['track_id'], additionalProperties: false, properties: { track_id: { type: 'integer' } } } } }, async (req, reply) => {
    const cfg = await loadFreeboxSettings();
    if (!cfg) return reply.code(400).send({ error: 'Freebox non configurée' });
    try {
      const { granted, app_token } = await checkFreeboxAuthorization(cfg, req.body.track_id);
      if (granted && app_token) {
        await saveFreeboxAppToken(app_token);
      }
      return { granted, app_token: app_token ? '***' : undefined };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'Erreur vérification' });
    }
  });
}
