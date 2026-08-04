import { HelpCircle } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { useStore } from '@/store/store';

export default function PageHeader({ title, subtitle, actions, helpTopic }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-white/5 px-6 py-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {(helpTopic || actions) && (
        <div className="flex items-center gap-2">
          {helpTopic && (
            <IconButton
              icon={HelpCircle}
              label="Page guide"
              side="bottom"
              onClick={() => useStore.getState().openHelp(helpTopic)}
            />
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
