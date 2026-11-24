import { X } from 'lucide-react';

export default function PanelHeader({ icon: Icon, title, onClose }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
        <Icon size={14} className="text-accent-300" /> {title}
      </span>
      <button aria-label={`Close ${title}`} onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10">
        <X size={14} />
      </button>
    </div>
  );
}

