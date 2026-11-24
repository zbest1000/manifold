import { useState } from 'react';
import { FolderTree } from 'lucide-react';
import { Button, Input, Field } from '@/components/ui';
import AssetPicker from './AssetPicker';
import { TEMPLATE_VARIABLES } from './helpers';

const help = 'text-xs leading-snug text-slate-400';

/**
 * Destination of a binding: an asset path (primary) with a picker over the existing UNS tree, or,
 * under Advanced, the legacy pathTemplate with {name}. An edited binding keeps the form it was stored with.
 */
export default function AssetPathField({ form, set, error, mqttSource = false }) {
  const [picking, setPicking] = useState(false);
  const [advanced, setAdvanced] = useState(form.destKind === 'template' && !mqttSource);

  if (mqttSource) {
    return (
      <Field label="Base path">
        <Input value={form.pathTemplate} onChange={(e) => set({ pathTemplate: e.target.value })} className="font-mono" aria-invalid={Boolean(error) || undefined} placeholder="site/area/line/{name}" />
        <span className={help}>Topics are re-pathed under this base. {error}</span>
      </Field>
    );
  }
  const asset = form.destKind === 'asset';
  return (
    <div className="space-y-2">
      <div>
        <label htmlFor="asset-path" className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">
          Asset path{asset ? '' : ' (not used, template is active)'}
        </label>
        <div className="flex gap-2">
          <Input
            id="asset-path"
            value={form.assetPath}
            onChange={(e) => set({ assetPath: e.target.value, destKind: 'asset' })}
            placeholder="acme/dallas/line4/filler"
            className="min-w-0 font-mono"
            aria-invalid={(asset && Boolean(error)) || undefined}
            aria-describedby="asset-path-help"
          />
          <Button variant="outline" onClick={() => setPicking(true)} disabled={!form.brokerId} title={form.brokerId ? undefined : 'Choose a broker first'}>
            <FolderTree size={14} aria-hidden="true" /> Browse
          </Button>
        </div>
        <p id="asset-path-help" className={`${help} mt-1.5`}>
          ISA-95 path of the asset, such as enterprise/site/area/line/cell. Each tag publishes to <span className="font-mono">{form.assetPath || '<asset path>'}/&lt;name&gt;</span>.
          Pick an existing branch or type a new path.
        </p>
      </div>
      <details open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)} className="rounded-xl border border-white/10 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-slate-300">Advanced: legacy path template</summary>
        <div className="mt-2 space-y-2">
          <label className="flex items-start gap-2 text-sm text-slate-100">
            <input
              type="checkbox"
              checked={!asset}
              onChange={(e) => set({ destKind: e.target.checked ? 'template' : 'asset' })}
              className="mt-1 accent-accent-500"
            />
            <span>
              Use a path template instead of an asset path
              <span className={`${help} block`}>
                {TEMPLATE_VARIABLES[0].token} is the tag name (spaces and / + # become _). Without it the name is appended. Object layout publishes to the template without its {'{name}'} segment.
              </span>
            </span>
          </label>
          <Input
            value={form.pathTemplate}
            onChange={(e) => set({ pathTemplate: e.target.value })}
            disabled={asset}
            aria-label="Path template"
            placeholder="site/area/line/{name}"
            className="font-mono"
            aria-invalid={(!asset && Boolean(error)) || undefined}
          />
        </div>
      </details>
      {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
      {picking && (
        <AssetPicker
          brokerId={form.brokerId}
          value={form.assetPath}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            set({ assetPath: p, destKind: 'asset' });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
