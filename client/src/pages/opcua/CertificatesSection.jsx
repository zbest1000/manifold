import { useState } from 'react';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import { api } from '@/lib/api';
import { usePolled } from '@/lib/usePolled';
import { Button, Banner, KeyValue, Skeleton } from '@/components/ui';
import { useReadOnly, READ_ONLY_REASON } from '@/store/selectors';
import { fmtDate } from './helpers';

/**
 * The certificate trust flow of a secure OPC UA connection, in the order it happens: give the server
 * Manifold's application certificate, connect (the server's own certificate is refused the first time),
 * then trust it here and connect again. Opens by default when the form uses a secure mode.
 */
export default function CertificatesSection({ defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="opcua-certificates"
        className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium text-fg transition-colors hover:text-accent-text"
      >
        <ChevronRight size={14} aria-hidden="true" className={clsx('text-subtle transition-transform duration-150', open && 'rotate-90')} />
        Certificates and trust
        <span className="hidden font-normal text-subtle sm:inline">for Sign and SignAndEncrypt connections</span>
      </button>
      {open && <CertificatesBody />}
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <li className="space-y-1.5">
      <p className="text-sm font-medium text-fg">
        <span className="mr-1.5 tabular-nums text-subtle">{n}.</span>
        {title}
      </p>
      <div className="space-y-2 text-sm text-muted">{children}</div>
    </li>
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
    <div id="opcua-certificates" className="mt-3 border-l-2 border-line pl-4">
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
        <ol className="space-y-5">
          <Step n={1} title="Give the server Manifold's application certificate">
            <p>The server's administrator has to trust this certificate before it accepts a secure session.</p>
            {cert && (
              <KeyValue
                items={[
                  ['Subject', <span key="s" className="block truncate" title={cert.subject || cert.applicationUri}>{cert.subject || cert.applicationUri}</span>],
                  ['Valid', `${fmtDate(cert.validFrom)} to ${fmtDate(cert.validTo)}`],
                  ['SHA-1 thumbprint', <span key="t" className="mono text-xs">{cert.thumbprint}</span>]
                ]}
              />
            )}
          </Step>
          <Step n={2} title="Connect once">
            <Banner variant="info">
              The first secure connect is expected to fail with a certificate error: the server&apos;s own certificate is refused until you trust it. Tick &quot;Trust server certificate on first connect&quot;
              to skip step 3.
            </Banner>
          </Step>
          <Step n={3} title="Trust the server's certificate, then connect again">
            {!trust?.rejected?.length ? (
              <p className="text-subtle">Nothing is waiting. A server whose certificate was refused appears here.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {trust.rejected.map((c) => (
                  <li key={c.thumbprint} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-fg" title={c.subject || c.file}>{c.subject || c.file}</p>
                      <p className="mono truncate text-xs text-subtle">{c.thumbprint}</p>
                    </div>
                    <Button type="button" size="sm" variant="secondary" disabled={readOnly} title={readOnly ? READ_ONLY_REASON : 'Move this certificate to the trusted list'} onClick={() => trustOne(c.thumbprint)} aria-label={`Trust certificate ${c.subject || c.file}`}>
                      <ShieldCheck size={13} aria-hidden="true" /> Trust
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {trust?.trusted?.length > 0 && (
              <p className="text-xs text-subtle">
                {trust.trusted.length} server {trust.trusted.length === 1 ? 'certificate is' : 'certificates are'} already trusted.
              </p>
            )}
          </Step>
        </ol>
      )}
    </div>
  );
}
