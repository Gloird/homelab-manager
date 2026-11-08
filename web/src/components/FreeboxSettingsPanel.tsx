// Freebox Settings Panel Component
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Shield, Activity, Wifi } from 'lucide-react';
import { api, type FreeboxSettings } from '../lib/api';
import { Button, Panel } from './ui';
import { useToast } from '../lib/toast';

export function FreeboxSettingsPanel() {
  const { data: freeboxSettings } = useQuery({ queryKey: ['settings', 'freebox'], queryFn: api.freeboxSettings });
  const [draft, setDraft] = useState<Partial<FreeboxSettings> | null>(null);
  const [authorizing, setAuthorizing] = useState<{ track_id: number; app_token: string } | null>(null);
  const authorizeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const stopAuthorizationPolling = () => {
    if (authorizeIntervalRef.current) {
      clearInterval(authorizeIntervalRef.current);
      authorizeIntervalRef.current = null;
    }
    setAuthorizing(null);
  };

  useEffect(() => () => {
    if (authorizeIntervalRef.current) clearInterval(authorizeIntervalRef.current);
  }, []);

  const handleSave = async () => {
    if (!draft) return;
    try {
      await api.saveFreeboxSettings(draft);
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['settings', 'freebox'] });
      toast.success('Configuration Freebox enregistrée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de l\'enregistrement');
    }
  };

  const handleTest = async () => {
    try {
      const result = await api.testFreebox();
      if (result.ok) {
        toast.success('Connexion à la Freebox réussie');
      } else {
        toast.error(result.error ?? 'Échec de la connexion');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur de test');
    }
  };

  const handleAuthorize = async () => {
    if (!freeboxSettings) return;
    try {
      const { track_id, app_token } = await api.authorizeFreebox();
      const startedAt = Date.now();
      stopAuthorizationPolling();
      setAuthorizing({ track_id, app_token });
      authorizeIntervalRef.current = setInterval(async () => {
        try {
          const result = await api.checkFreeboxAuthorization(track_id, app_token);
          if (result.granted) {
            stopAuthorizationPolling();
            await qc.invalidateQueries({ queryKey: ['settings', 'freebox'] });
            toast.success('Autorisation accordée ! La Freebox est maintenant connectée.');
            return;
          }
          if (result.status === 'denied') {
            stopAuthorizationPolling();
            toast.error('Autorisation refusée sur la Freebox.');
            return;
          }
          if (result.status === 'timeout' || Date.now() - startedAt >= 120_000) {
            stopAuthorizationPolling();
            toast.error('La demande d\'autorisation a expiré. Relancez-la.');
          }
        } catch {
          // Ignore errors during polling
        }
      }, 2000);
      toast.success('Autorisation demandée. Validez sur l\'écran de la Freebox (vous avez 2 minutes).');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la demande d\'autorisation');
    }
  };

  const handleCancelAuthorize = () => {
    if (authorizing) {
      stopAuthorizationPolling();
      toast.success('Demande d\'autorisation annulée');
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Jamais';
    const date = new Date(dateStr);
    return date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-4">
      <Panel title="Freebox OS" icon={Wifi}>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="freebox-enabled"
              checked={freeboxSettings?.enabled ?? false}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              className="checkbox"
            />
            <label htmlFor="freebox-enabled" className="text-sm font-medium cursor-pointer">
              Activer l'intégration Freebox
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="freebox-url" className="block text-xs text-muted mb-1">URL de la Freebox</label>
              <input
                id="freebox-url"
                type="text"
                value={draft?.url ?? freeboxSettings?.url ?? 'http://mafreebox.freebox.fr'}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                className="input w-full"
                placeholder="http://mafreebox.freebox.fr"
              />
              <p className="text-xs text-muted mt-1">Ex: http://mafreebox.freebox.fr ou https://&lt;domaine&gt;.fbxos.fr:port</p>
</div>
            <div>
              <label htmlFor="freebox-api-version" className="block text-xs text-muted mb-1">Version API</label>
              <select
                id="freebox-api-version"
                value={draft?.apiVersion ?? freeboxSettings?.apiVersion ?? 4}
                onChange={(e) => setDraft({ ...draft, apiVersion: Number(e.target.value) })}
                className="input w-full"
              >
                <option value={4}>v4 (Freebox Révolution, Mini 4K, Delta, Pop)</option>
                <option value={5}>v5 (Freebox Ultra)</option>
                <option value={6}>v6 (Future)</option>
              </select>
            </div>
            <div>
              <label htmlFor="freebox-app-id" className="block text-xs text-muted mb-1">App ID</label>
              <input
                id="freebox-app-id"
                type="text"
                value={draft?.appId ?? freeboxSettings?.appId ?? 'homelab-manager'}
                onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
                className="input w-full"
                placeholder="homelab-manager"
              />
            </div>
            <div>
              <label htmlFor="freebox-app-name" className="block text-xs text-muted mb-1">Nom de l'application</label>
              <input
                id="freebox-app-name"
                type="text"
                value={draft?.appName ?? freeboxSettings?.appName ?? 'Homelab Manager'}
                onChange={(e) => setDraft({ ...draft, appName: e.target.value })}
                className="input w-full"
                placeholder="Homelab Manager"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="primary" onClick={handleSave} disabled={!draft}>
              Enregistrer
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)} disabled={!draft}>
              Annuler
            </Button>
          </div>
        </div>
      </Panel>

      {freeboxSettings?.enabled && (
        <>
          <Panel title="Autorisation" icon={Shield}>
            <div className="space-y-4">
              {authorizing ? (
                <div className="space-y-3 p-4 rounded-md bg-amber-900/20 border border-amber-800">
                  <div className="flex items-center gap-3">
                    <div className="animate-spin rounded-full h-6 w-6 border-2 border-amber-400 border-t-transparent" />
                    <span className="text-sm text-amber-300">En attente de validation sur la Freebox…</span>
                  </div>
                  <p className="text-xs text-muted">Vous avez 2 minutes pour valider sur l'écran de la Freebox ou dans l'app Freebox Connect.</p>
                  <Button variant="ghost" size="sm" onClick={handleCancelAuthorize}>Annuler</Button>
                </div>
              ) : freeboxSettings.appToken ? (
                <div className="space-y-3 p-4 rounded-md bg-emerald-900/20 border border-emerald-800">
                  <div className="flex items-center gap-3">
                    <Shield className="h-5 w-5 text-emerald-400" />
                    <span className="text-sm font-medium text-emerald-300">Freebox autorisée et connectée</span>
                  </div>
                  <p className="text-xs text-muted">L'application a accès à la Freebox. Les données sont récupérées automatiquement toutes les 5 minutes.</p>
                </div>
              ) : (
                <div className="space-y-3 p-4 rounded-md bg-zinc-800/50 border border-zinc-700">
                  <div className="flex items-center gap-3">
                    <Shield className="h-5 w-5 text-zinc-500" />
                    <span className="text-sm text-zinc-400">Freebox non autorisée</span>
                  </div>
                  <p className="text-xs text-muted">Lancez l'autorisation pour permettre à Homelab Manager d'accéder à votre Freebox.</p>
                  <Button onClick={handleAuthorize}>Autoriser l'application</Button>
                </div>
              )}
            </div>
          </Panel>
        </>
      )}

      <Panel title="Test et statut" icon={Activity}>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleTest} disabled={!freeboxSettings?.enabled || !freeboxSettings?.appToken}>
              Tester la connexion
            </Button>
          </div>

          <dl className="grid gap-3 sm:grid-cols-2 text-sm">
            <div className="rounded-md border border-line bg-raised/30 p-3">
              <dt className="text-xs text-muted">Dernier poll</dt>
              <dd className="mt-1 font-mono text-zinc-100">{formatDate(freeboxSettings?.polledAt ?? null)}</dd>
            </div>
            <div className="rounded-md border border-line bg-raised/30 p-3">
              <dt className="text-xs text-muted">Erreur du dernier poll</dt>
              <dd className="mt-1 font-mono text-zinc-100 text-red-400">{freeboxSettings?.pollError ?? 'Aucune'}</dd>
            </div>
            <div className="rounded-md border border-line bg-raised/30 p-3">
              <dt className="text-xs text-muted">URL configurée</dt>
              <dd className="mt-1 font-mono text-zinc-100 truncate">{freeboxSettings?.url ?? 'Non définie'}</dd>
            </div>
            <div className="rounded-md border border-line bg-raised/30 p-3">
              <dt className="text-xs text-muted">Type d'appareil</dt>
              <dd className="mt-1 font-mono text-zinc-100">{freeboxSettings?.deviceType ?? 'Inconnu'}</dd>
            </div>
          </dl>

          {freeboxSettings?.enabled && freeboxSettings?.appToken && (
            <div className="rounded-md border border-line bg-raised/30 p-3 text-sm text-zinc-400">
              <p>Les données Freebox (connexion, système, disques, VMs, WiFi, appareils connectés) sont disponibles dans l'onglet <strong>Équipements</strong> (source: Freebox).</p>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}