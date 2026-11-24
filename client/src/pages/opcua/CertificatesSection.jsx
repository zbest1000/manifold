import { useState } from 'react';
import { ShieldCheck, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Banner, Skeleton } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { fmtDate } from './helpers';

/**
 * Collapsible PKI panel for the connect form: shows Manifold's application
 * certificate (to hand to server admins) and lets the user promote rejected
 * server certificates to trusted after a failed secure connect.
 */
export default function CertificatesSection() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-white/5 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="opcua-certificates"
        className="flex items-center gap-1.5 rounded text-xs font-medium uppercase tracking-wide text-muted hover:text-slate-200"
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <ShieldCheck size={13} aria-hidden="true" /> Certificates
      </button>
      {open && <CertificatesBody />}
    </div>
  );
}

// Mounted only while the section is open, so nothing is fetched until then.
function CertificatesBody() {
  const { data, error, loading, reload } = usePolled(async () => {
    const [cert, trust] = await Promise.all([api.opcuaCertificate(), api.opcuaTrustList()]);
    return { cert, trust };
  });
  const readOnly = useReadOnly();
  const cert = data?.cert;
  const trust = data?.trust;

  const trustOne = async (thumbprint) => {
    try {
      await api.opcuaTrust(thumbprint);
      toast.success('Server certificate trusted');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div id="opcua-certificates" className="mt-3 space-y-3 text-xs">
      {error ? (
        <Banner variant="error" title="Could not load certificates" onRetry={reload}>
          {error.message}
        </Banner>
      ) : loading && !cert ? (
        <div role="status" aria-busy="true" className="space-y-2">
          <span className="sr-only">Loading certificates…</span>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <>
        {cert && (
          <div className="rounded-xl border border-white/10 bg-surface-950/40 p-3">
            <p className="label-xs mb-1">Application certificate</p>
            <p className="break-all text-slate-300">{cert.subject || cert.applicationUri}</p>
            <p className="helper mt-1">
              Valid {fmtDate(cert.validFrom)} – {fmtDate(cert.validTo)}
            </p>
            <p className="mono helper mt-1 break-all">SHA1 {cert.thumbprint}</p>
          </div>
        )}

        <div>
          <p className="label-xs mb-1.5">Rejected server certificates</p>
          {!trust?.rejected?.length ? (
            <p className="helper">None — servers you reject (or that fail trust checks) appear here.</p>
          ) : (
            <ul className="space-y-1.5">
              {trust.rejected.map((c) => (
                <li key={c.thumbprint} className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-surface-950/40 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-slate-300">{c.subject || c.file}</p>
                    <p className="mono helper truncate">{c.thumbprint}</p>
                  </div>
                  <Button type="button" size="sm" variant="outline" disabled={readOnly} title={readOnly ? READ_ONLY_REASON : 'Move this certificate to the trusted list'} onClick={() => trustOne(c.thumbprint)} aria-label={`Trust certificate ${c.subject || c.file}`}>
                    <ShieldCheck size={13} aria-hidden="true" /> Trust
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {trust?.trusted?.length > 0 && (
          <div>
            <p className="label-xs mb-1.5">Trusted server certificates</p>
            <ul className="space-y-1">
              {trust.trusted.map((c) => (
                <li key={c.thumbprint} className="helper truncate">
                  <span className="text-slate-300">{c.subject || c.file}</span>
                  <span className="mono"> · {c.thumbprint.slice(0, 16)}…</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        </>
      )}
    </div>
  );
}
