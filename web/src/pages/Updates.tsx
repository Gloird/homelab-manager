import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowUpCircle, PackageCheck, Search } from 'lucide-react';
import { RebootTag } from '../components/Reboot';
import { useToast } from '../lib/toast';
import { HeaderTitle } from '../components/HeaderSlot';
import { Badge, Button, Checkbox, Empty, ResponsiveList, Spinner } from '../components/ui';
import { api, type Host } from '../lib/api';
import { useHosts } from '../lib/queries';
import { useMe } from '../lib/auth';

interface Row {
  name: string;
  security: boolean;
  reboot: boolean;
  candidates: Set<string>;
  hosts: Host[];
}

interface WingetRow {
  id: string;
  name: string;
  available: Set<string>;
  hosts: Host[];
}

interface WindowsRow {
  key: string;
  label: string;
  severity: string;
  hosts: Host[];
}

// Package-centric view: "openssl is outdated on 14 hosts".
export function Updates() {
  const { data: hosts, isLoading } = useHosts();
  const toast = useToast();
  const { canWrite } = useMe();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const securityOnly = params.get('security') === '1';
  // package whose upgrade is being started
  const [busy, setBusy] = useState<string | null>(null);
  const [busyWindows, setBusyWindows] = useState<string | null>(null);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    const map = new Map<string, Row>();
    for (const h of hosts ?? []) {
      for (const p of h.apt?.upgradable ?? []) {
        const r = map.get(p.name) ?? { name: p.name, security: false, reboot: false, candidates: new Set(), hosts: [] };
        r.security ||= p.security;
        r.reboot ||= !!p.reboot;
        r.candidates.add(p.candidate);
        r.hosts.push(h);
        map.set(p.name, r);
      }
    }
    return [...map.values()].sort((a, b) => Number(b.security) - Number(a.security) || b.hosts.length - a.hosts.length || a.name.localeCompare(b.name));
  }, [hosts]);

  const list = rows.filter((r) => (!securityOnly || r.security) && r.name.includes(q.toLowerCase()));
  const affected = new Set(rows.flatMap((r) => r.hosts.map((h) => h.id))).size;
  const windowsHosts = (hosts ?? []).filter((h) => h.info?.osId === 'windows');

  const wingetRows = useMemo(() => {
    const map = new Map<string, WingetRow>();
    for (const h of windowsHosts) {
      for (const u of h.pendingUpdates?.winget ?? []) {
        const key = u.id || u.name;
        if (!key) continue;
        const row = map.get(key) ?? { id: key, name: u.name || key, available: new Set(), hosts: [] };
        if (u.available) row.available.add(u.available);
        row.hosts.push(h);
        map.set(key, row);
      }
    }
    return [...map.values()].sort((a, b) => b.hosts.length - a.hosts.length || a.name.localeCompare(b.name));
  }, [windowsHosts]);

  const windowsRows = useMemo(() => {
    const map = new Map<string, WindowsRow>();
    for (const h of windowsHosts) {
      for (const u of h.pendingUpdates?.windows ?? []) {
        const key = `${u.kbArticleId ?? ''}\x00${u.title}`;
        const label = u.kbArticleId ? `${u.kbArticleId} · ${u.title}` : u.title;
        const row = map.get(key) ?? { key, label, severity: u.severity ?? '', hosts: [] };
        row.hosts.push(h);
        map.set(key, row);
      }
    }
    return [...map.values()].sort((a, b) => b.hosts.length - a.hosts.length || a.label.localeCompare(b.label));
  }, [windowsHosts]);

  const upgrade = async (row: Row) => {
    setBusy(row.name);
    const targets = row.hosts.filter((h) => h.online);
    let ok = 0;
    for (const h of targets) {
      try {
        const j = await api.runJob(h.id, 'apt_upgrade', [row.name]);
        if (j.status !== 'failed') ok++;
      } catch {
        // reported below through the counter
      }
    }
    setBusy(null);
    if (ok) toast.success(`${row.name} : mise à jour lancée sur ${ok} hôte(s)`);
    if (ok < targets.length) toast.error(`${targets.length - ok} hôte(s) n'ont pas pu démarrer la mise à jour`);
  };

  const runWingetAll = async (host: Host) => {
    setBusyWindows(`winget:${host.id}`);
    try {
      await api.runWingetUpdates(host.id);
      toast.success(`${host.name} : mise à jour Winget lancée`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyWindows(null);
    }
  };

  const runWindowsUpdates = async (host: Host) => {
    setBusyWindows(`windows:${host.id}`);
    try {
      await api.runWindowsUpdates(host.id);
      toast.success(`${host.name} : installation Windows Update lancée`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusyWindows(null);
    }
  };

  if (isLoading || !hosts) return <div className="flex justify-center p-20"><Spinner /></div>;

  return (
    <>
      <HeaderTitle icon={PackageCheck} title="Mises à jour" />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {[
          { label: 'Paquets distincts', value: rows.length, cls: 'text-amber-400' },
          { label: 'Dont sécurité', value: rows.filter((r) => r.security).length, cls: 'text-red-400' },
          { label: 'Hôtes concernés', value: `${affected} / ${hosts.length}`, cls: 'text-zinc-100' },
        ].map((s) => (
          <div key={s.label} className="panel px-5 py-4">
            <div className={`text-2xl font-semibold tabular-nums ${s.cls}`}>{s.value}</div>
            <div className="mt-1 text-xs text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      {windowsHosts.length > 0 && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          {[
            { label: 'Apps Winget à mettre à jour', value: wingetRows.length, cls: 'text-sky-300' },
            { label: 'Correctifs Windows (KB)', value: windowsRows.length, cls: 'text-violet-300' },
            { label: 'Hôtes Windows concernés', value: `${new Set([...wingetRows, ...windowsRows].flatMap((r) => r.hosts.map((h) => h.id))).size} / ${windowsHosts.length}`, cls: 'text-zinc-100' },
          ].map((s) => (
            <div key={s.label} className="panel px-5 py-4">
              <div className={`text-2xl font-semibold tabular-nums ${s.cls}`}>{s.value}</div>
              <div className="mt-1 text-xs text-muted">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input className="input h-9 py-0 pl-9" placeholder="Filtrer les paquets" value={q} onChange={(e) => setParam('q', e.target.value)} />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-300">
          <Checkbox checked={securityOnly} onChange={(checked) => setParam('security', checked ? '1' : '')} /> Sécurité uniquement
        </label>
      </div>

      <div className="panel min-w-0">
        {list.length === 0 ? (
          <Empty icon={PackageCheck} title={rows.length ? 'Aucun paquet ne correspond' : 'Tout est à jour'} />
        ) : (
          <>
          <ResponsiveList mode="mobile">
            {list.map((r) => (
              <article key={r.name} className="min-w-0 space-y-3 p-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h2 className="min-w-0 break-all font-medium text-zinc-100">{r.name}</h2>
                  {r.security && <Badge tone="bad">sécurité</Badge>}
                  {r.reboot && <RebootTag />}
                </div>
                <div className="break-all font-mono text-xs text-emerald-300">{[...r.candidates].join(', ')}</div>
                <div className="flex flex-wrap gap-1.5">
                  {r.hosts.map((h) => (
                    <Link key={h.id} to={`/hosts/${h.id}`} className={`rounded-sm px-2 py-1 text-xs font-semibold ${h.online ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700' : 'bg-zinc-900 text-zinc-500 line-through'}`}>
                      {h.name}
                    </Link>
                  ))}
                </div>
                {canWrite && (
                  <Button
                    size="sm"
                    icon={ArrowUpCircle}
                    className="min-h-10 w-full md:min-h-0 md:w-auto"
                    disabled={!r.hosts.some((h) => h.online) || !!busy}
                    loading={busy === r.name}
                    onClick={() => upgrade(r)}
                  >
                    Mettre à jour ({r.hosts.filter((h) => h.online).length})
                  </Button>
                )}
              </article>
            ))}
          </ResponsiveList>
          <ResponsiveList mode="desktop">
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr>
                <th className="th">Paquet</th>
                <th className="th">Version disponible</th>
                <th className="th">Hôtes</th>
                <th className="th text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((r) => (
                <tr key={r.name} className="hover:bg-raised/40">
                  <td className="td">
                    <span className="font-medium text-zinc-100">{r.name}</span>
                    {r.security && <Badge tone="bad" className="ml-2">sécurité</Badge>}
                    {r.reboot && <RebootTag />}
                  </td>
                  <td className="td font-mono text-xs text-emerald-300">{[...r.candidates].join(', ')}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1.5">
                      {r.hosts.map((h) => (
                        <Link key={h.id} to={`/hosts/${h.id}`} className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${h.online ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700' : 'bg-zinc-900 text-zinc-500 line-through'}`}>
                          {h.name}
                        </Link>
                      ))}
                    </div>
                  </td>
                  <td className="td text-right">
                    {canWrite && <Button size="sm" icon={ArrowUpCircle} disabled={!r.hosts.some((h) => h.online) || !!busy} loading={busy === r.name} onClick={() => upgrade(r)}>
                      Mettre à jour ({r.hosts.filter((h) => h.online).length})
                    </Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </ResponsiveList>
          </>
        )}
      </div>

      {windowsHosts.length > 0 && (
        <>
          <div className="panel mt-5 min-w-0">
            <div className="border-b border-line px-4 py-3 text-sm font-semibold text-zinc-100">Mises à jour Winget</div>
            {wingetRows.length === 0 ? (
              <Empty icon={PackageCheck} title="Aucune mise à jour Winget détectée" />
            ) : (
              <ResponsiveList mode="desktop">
                <table className="w-full text-sm">
                  <thead className="border-b border-line">
                    <tr>
                      <th className="th">Application</th>
                      <th className="th">Version disponible</th>
                      <th className="th">Hôtes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {wingetRows.map((r) => (
                      <tr key={r.id} className="hover:bg-raised/40">
                        <td className="td">
                          <div className="font-medium text-zinc-100">{r.name}</div>
                          <div className="font-mono text-xs text-muted">{r.id}</div>
                        </td>
                        <td className="td font-mono text-xs text-emerald-300">{[...r.available].join(', ') || '—'}</td>
                        <td className="td">
                          <div className="flex flex-wrap gap-1.5">
                            {r.hosts.map((h) => (
                              <Link key={h.id} to={`/hosts/${h.id}`} className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${h.online ? 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700' : 'bg-zinc-900 text-zinc-500 line-through'}`}>
                                {h.name}
                              </Link>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ResponsiveList>
            )}
          </div>

          <div className="panel mt-5 min-w-0">
            <div className="border-b border-line px-4 py-3 text-sm font-semibold text-zinc-100">Actions Windows</div>
            <div className="divide-y divide-line">
              {windowsHosts.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <Link to={`/hosts/${h.id}`} className="font-medium text-zinc-100 hover:text-emerald-300">{h.name}</Link>
                    <div className="text-xs text-muted">
                      Winget: {h.pendingUpdates?.winget.length ?? 0} · Windows: {h.pendingUpdates?.windows.length ?? 0}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canWrite && (
                      <>
                        <Button
                          size="sm"
                          icon={ArrowUpCircle}
                          disabled={!h.online || !!busyWindows}
                          loading={busyWindows === `winget:${h.id}`}
                          onClick={() => runWingetAll(h)}
                        >
                          Tout mettre à jour (Winget)
                        </Button>
                        <Button
                          size="sm"
                          icon={ArrowUpCircle}
                          disabled={!h.online || !!busyWindows}
                          loading={busyWindows === `windows:${h.id}`}
                          onClick={() => runWindowsUpdates(h)}
                        >
                          Installer les KB Windows
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

    </>
  );
}
