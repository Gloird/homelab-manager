import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { api, type FreeboxHealthReport } from '../lib/api';
import { formatBytes } from '../lib/backups';
import { dateTime } from '../lib/format';
import { keys } from '../lib/queries';
import { Panel, Spinner } from './ui';

type Sample = { sampledAt: string; report: FreeboxHealthReport };
type Series = { key: string; label: string; color: string; unit: string; pick: (report: FreeboxHealthReport) => number | undefined };

const seriesList: Series[] = [
  { key: 'tempC', label: 'Température', color: '#f59e0b', unit: ' °C', pick: (r) => r.tempC },
  { key: 'downRate', label: 'Débit descendant', color: '#22d3ee', unit: ' kbit/s', pick: (r) => r.downRate },
  { key: 'upRate', label: 'Débit montant', color: '#60a5fa', unit: ' kbit/s', pick: (r) => r.upRate },
  { key: 'diskUsedPercent', label: 'Disque utilisé', color: '#a78bfa', unit: ' %', pick: (r) => r.diskUsedPercent },
];

function SeriesChart({ samples, series }: { samples: Sample[]; series: Series }) {
  const points = samples
    .map((sample) => ({ t: new Date(sample.sampledAt).getTime(), v: series.pick(sample.report) }))
    .filter((sample): sample is { t: number; v: number } => sample.v !== undefined);
  if (points.length === 0) return null;

  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const spanT = Math.max(1, maxT - minT);
  const maxV = Math.max(1, ...points.map((p) => p.v));
  const minV = Math.min(0, ...points.map((p) => p.v));
  const spanV = Math.max(1, maxV - minV);
  const x = (t: number) => 12 + ((t - minT) / spanT) * 476;
  const y = (v: number) => 124 - ((v - minV) / spanV) * 108;
  const poly = points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ');
  const last = points[points.length - 1].v;

  return (
    <div className="rounded-md border border-line bg-raised/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm">
        <span style={{ color: series.color }}>{series.label}</span>
        <span className="font-mono text-zinc-100">{last.toFixed(series.unit.includes('%') ? 1 : 0)}{series.unit}</span>
      </div>
      {points.length >= 2 ? (
        <svg viewBox="0 0 500 136" className="h-28 w-full">
          <polyline points={poly} fill="none" stroke={series.color} strokeWidth={2} />
        </svg>
      ) : (
        <div className="flex h-28 items-center justify-center text-xs text-muted">En attente d&apos;un second point</div>
      )}
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{dateTime(minT)}</span>
        <span>{dateTime(maxT)}</span>
      </div>
    </div>
  );
}

export function FreeboxHealthPanel({ equipmentId }: { equipmentId: string }) {
  const [hours, setHours] = useState(24);
  const { data, isLoading, error } = useQuery({
    queryKey: keys.equipmentHealth(equipmentId, hours),
    queryFn: () => api.equipmentHealth(equipmentId, hours),
    refetchInterval: 60_000,
  });
  const samples = data?.samples ?? [];
  const latest = samples.length > 0 ? samples[samples.length - 1].report : null;
  const visibleSeries = useMemo(() => seriesList.filter((s) => samples.some((sample) => s.pick(sample.report) !== undefined)), [samples]);
  const latestAt = samples.length > 0 ? samples[samples.length - 1].sampledAt : null;

  return (
    <Panel
      title="Historique Freebox"
      icon={Activity}
      actions={(
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="input h-8 w-28 py-0 text-xs">
          <option value={1}>1 heure</option>
          <option value={6}>6 heures</option>
          <option value={24}>24 heures</option>
          <option value={72}>72 heures</option>
          <option value={168}>7 jours</option>
        </select>
      )}
    >
      {isLoading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : error ? (
        <p className="text-sm text-amber-300">Historique indisponible : {(error as Error).message}</p>
      ) : samples.length === 0 ? (
        <p className="text-sm text-muted">Pas encore assez de mesures Freebox pour tracer des graphes.</p>
      ) : (
        <div className="space-y-3">
          {latest && (
            <div className="grid gap-2 text-xs text-muted sm:grid-cols-2 lg:grid-cols-3">
              <span>Température: <span className="font-mono text-zinc-100">{latest.tempC !== undefined ? `${latest.tempC.toFixed(1)} °C` : '—'}</span></span>
              <span>Débit descendant: <span className="font-mono text-zinc-100">{latest.downRate !== undefined ? `${latest.downRate} kbit/s` : '—'}</span></span>
              <span>Débit montant: <span className="font-mono text-zinc-100">{latest.upRate !== undefined ? `${latest.upRate} kbit/s` : '—'}</span></span>
              <span>Appareils LAN: <span className="font-mono text-zinc-100">{latest.lanDevices !== undefined ? latest.lanDevices : '—'}</span></span>
              <span>VM: <span className="font-mono text-zinc-100">{latest.vmTotal !== undefined ? `${latest.vmRunning ?? 0}/${latest.vmTotal}` : '—'}</span></span>
              <span>Stockage: <span className="font-mono text-zinc-100">{latest.diskTotalBytes !== undefined && latest.diskUsedBytes !== undefined ? `${formatBytes(latest.diskUsedBytes)} / ${formatBytes(latest.diskTotalBytes)}` : '—'}</span></span>
              {latestAt && <span className="sm:col-span-2 lg:col-span-3">Dernier point: <span className="font-mono text-zinc-100">{dateTime(latestAt)}</span></span>}
            </div>
          )}
          <div className="grid gap-3 lg:grid-cols-2">
            {visibleSeries.map((series) => <SeriesChart key={series.key} samples={samples} series={series} />)}
          </div>
        </div>
      )}
    </Panel>
  );
}
