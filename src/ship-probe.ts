// src/ship-probe.ts
//
// An unlinked page for one question we cannot answer from shore:
//
//   Aboard, does the ship's gateway stamp environment-marker on responses from
//   OUR origin, or only on api.rccl.com?
//
// Everything about those headers comes from decompiled bytecode. On native the
// app reads them off RCCL's own responses, which works because CapacitorHttp is
// not bound by CORS. A browser is, so the same trick cannot work there — a
// cross-origin response only exposes the headers its server chooses to expose,
// and RCCL will not be exposing these.
//
// Two ways out, and we cannot tell from here which is real:
//
//   SAME-ORIGIN   the gateway is a transparent proxy, so it should stamp a
//                 request to our own host too — and a same-origin response
//                 exposes every header to JavaScript with no CORS involved.
//   EXPOSED       our own Worker could name the headers in
//                 Access-Control-Expose-Headers, which would surface them on a
//                 cross-origin response IF the gateway stamps that host at all.
//
// So this page tries both and prints everything it sees. One voyage settles it;
// guessing does not. Reached at ?shipprobe and linked from nowhere.
//
// It prints response headers from our own origin and from our own Workers, and
// nothing else — no app key, no location, no clock list.

import { readEnvironment } from './rccl';

interface Attempt {
  name: string;
  detail: string;
  ok: boolean;
  headers: Record<string, string>;
  marker: string | null;
  shipCode: string | null;
  shipTime: string | null;
  error?: string;
}

function headerRecord(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

async function attempt(name: string, detail: string, run: () => Promise<Response>): Promise<Attempt> {
  try {
    const res = await run();
    const headers = headerRecord(res);
    const env = readEnvironment(headers);
    return {
      name, detail, ok: true, headers,
      marker: env.marker, shipCode: env.shipCode, shipTime: env.shipTime,
    };
  } catch (err) {
    return {
      name, detail, ok: false, headers: {},
      marker: null, shipCode: null, shipTime: null,
      error: String(err),
    };
  }
}

async function gather(): Promise<Attempt[]> {
  const origin = window.location.origin;
  return [
    // HEAD rather than GET on purpose: Workbox routes only GET, so this reaches
    // the network instead of being answered by the service worker cache — which
    // would have no gateway headers on it at all.
    await attempt('same-origin HEAD', `${origin}/`,
      () => fetch(`${origin}/`, { method: 'HEAD', cache: 'no-store' })),
    await attempt('same-origin GET (cache-busted)', `${origin}/icons/favicon.svg`,
      () => fetch(`${origin}/icons/favicon.svg?probe=${Date.now()}`, { cache: 'no-store' })),
    await attempt('cross-origin, our Worker', 'geotime-ship-track /fleet',
      () => fetch('https://geotime-ship-track.matthew-carroll.workers.dev/fleet', { cache: 'no-store' })),
  ];
}

function render(attempts: Attempt[]): string {
  const lines: string[] = [];
  lines.push('GeoTime ship probe');
  lines.push(new Date().toISOString());
  lines.push(`user agent: ${navigator.userAgent}`);
  lines.push('');
  lines.push('The question: does anything below report marker=ship?');
  lines.push('If one does, browser ship mode is possible by that route.');
  lines.push('');

  for (const a of attempts) {
    lines.push('─'.repeat(58));
    lines.push(`${a.name}`);
    lines.push(`  ${a.detail}`);
    if (!a.ok) {
      lines.push(`  FAILED: ${a.error}`);
      lines.push('');
      continue;
    }
    lines.push(`  marker     : ${a.marker ?? '(none)'}`);
    lines.push(`  ship code  : ${a.shipCode ?? '(none)'}`);
    lines.push(`  ship-time  : ${a.shipTime ?? '(absent)'}`);
    const keys = Object.keys(a.headers).sort();
    lines.push(`  headers visible to JS (${keys.length}):`);
    if (keys.length === 0) {
      lines.push('    (none — cross-origin, and the server exposed nothing)');
    }
    for (const k of keys) lines.push(`    ${k}: ${a.headers[k]}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Replaces the page with the probe when the URL asks for it.
 *
 * Returns true when it took over, so the caller can stop before starting the
 * app proper — there is no point resolving clocks behind a diagnostic.
 */
export function maybeRunShipProbe(): boolean {
  if (!window.location.search.includes('shipprobe')) return false;

  document.body.innerHTML = '';
  document.body.style.background = '#111827';
  const pre = document.createElement('pre');
  pre.style.cssText =
    'color:#e5e7eb;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;'
    + 'padding:16px;white-space:pre-wrap;word-break:break-word;margin:0';
  pre.textContent = 'Probing…';
  document.body.appendChild(pre);

  const copy = document.createElement('button');
  copy.textContent = 'Copy';
  copy.style.cssText =
    'position:fixed;top:12px;right:12px;padding:8px 14px;border:none;'
    + 'border-radius:8px;background:#2563eb;color:#fff;font:14px system-ui';
  document.body.appendChild(copy);

  void gather().then((attempts) => {
    const text = render(attempts);
    pre.textContent = text;
    copy.onclick = () => {
      void navigator.clipboard.writeText(text).then(
        () => { copy.textContent = 'Copied'; },
        () => { copy.textContent = 'Select and copy'; },
      );
    };
  });

  return true;
}
