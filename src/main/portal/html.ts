/**
 * Server-rendered HTML for the client portal (T707). No scripts, no external
 * assets; the response CSP is `default-src 'none'` plus inline styles. Every
 * dynamic string goes through `esc`, and links are http(s) only.
 */

import {
  PORTAL_WORK_STATUS_LABELS,
  isSafeHttpUrl,
  type PortalLinkItem,
  type PortalView,
  type PortalWorkItem,
} from '@/shared/portal';
import { RENEWAL_STATE_LABELS } from '@/shared/renewals';

export function esc(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function link(url: string | null, text: string): string {
  if (!url || !isSafeHttpUrl(url)) return esc(text);
  return `<a href="${esc(url)}" rel="noopener noreferrer" target="_blank">${esc(text)}</a>`;
}

function paragraphs(body: string | null): string {
  if (!body) return '';
  return body
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function workRow(i: PortalWorkItem): string {
  const meta: string[] = [];
  if (i.completed_on) meta.push(`Completed ${esc(i.completed_on)}`);
  else if (i.due_on) meta.push(`Due ${esc(i.due_on)}`);
  return `<li class="row">
    <span class="title">${link(i.url, i.title)}</span>
    <span class="meta"><span class="pill pill-${esc(i.status)}">${esc(PORTAL_WORK_STATUS_LABELS[i.status])}</span>${meta.length ? ` ${meta.join(' ')}` : ''}</span>
  </li>`;
}

function entryBlock(e: PortalLinkItem): string {
  return `<li class="entry"><div class="title">${link(e.url, e.title)}</div>${paragraphs(e.body)}</li>`;
}

function section(title: string, inner: string, id: string): string {
  return `<section aria-labelledby="${id}"><h2 id="${id}">${esc(title)}</h2>${inner}</section>`;
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5d50;
--done:#e3efe9;--done-t:#235242;--prog:#e7ecf6;--prog-t:#2b4a7d;--wait:#f8ecd9;--wait-t:#7a4f12;--over:#f7e1df;--over-t:#8a2c22}
@media (prefers-color-scheme:dark){:root{--bg:#151614;--card:#1d1e1c;--text:#ecece8;--muted:#a3a39c;--line:#30312e;--accent:#8cc4b1;
--done:#1f3329;--done-t:#a7d8c3;--prog:#1e2838;--prog-t:#a9c1ea;--wait:#38291a;--wait-t:#f0c98d;--over:#3a1f1c;--over-t:#f2aaa1}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
header{margin-bottom:24px}
h1{font-size:24px;line-height:1.25;margin:0 0 4px}
.sub{color:var(--muted);margin:0}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 16px}
h2{font-size:15px;margin:0 0 10px}
h3{font-size:13px;color:var(--muted);font-weight:600;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.04em}
ul{list-style:none;margin:0;padding:0}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;padding:8px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.meta{color:var(--muted);font-size:13px;white-space:nowrap}
.entry{padding:8px 0;border-top:1px solid var(--line)}
.entry:first-child{border-top:0}
.entry p{margin:4px 0 0;color:var(--text)}
.title{font-weight:500;overflow-wrap:anywhere}
a{color:var(--accent)}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;margin-right:4px}
.pill-completed{background:var(--done);color:var(--done-t)}
.pill-in_progress,.pill-scheduled,.pill-upcoming,.pill-due_soon{background:var(--prog);color:var(--prog-t)}
.pill-waiting_on_you{background:var(--wait);color:var(--wait-t)}
.pill-overdue{background:var(--over);color:var(--over-t)}
.empty{color:var(--muted);margin:0}
footer{color:var(--muted);font-size:12px;margin-top:24px}
`;

export function renderPortalHtml(view: PortalView): string {
  const parts: string[] = [];

  if (view.monthly_notes.length > 0) {
    parts.push(section('Monthly notes', `<ul>${view.monthly_notes.map(entryBlock).join('')}</ul>`, 'notes'));
  }

  if (view.work.completed.length > 0 || view.work.in_progress.length > 0) {
    let inner = '';
    if (view.work.completed.length > 0) {
      inner += `<h3>Completed</h3><ul>${view.work.completed.map(workRow).join('')}</ul>`;
    }
    if (view.work.in_progress.length > 0) {
      inner += `<h3>In progress</h3><ul>${view.work.in_progress.map(workRow).join('')}</ul>`;
    }
    parts.push(section(`Work in ${view.month_label}`, inner, 'work'));
  }

  if (view.deliverables.length > 0) {
    parts.push(section('Findings and deliverables', `<ul>${view.deliverables.map(entryBlock).join('')}</ul>`, 'deliverables'));
  }

  if (view.renewals.length > 0) {
    const rows = view.renewals
      .map(
        (r) => `<li class="row">
      <span class="title">${esc(r.label)} <span class="meta">${esc(r.item_type_label)}</span></span>
      <span class="meta"><span class="pill pill-${esc(r.state)}">${esc(RENEWAL_STATE_LABELS[r.state])}</span> Due ${esc(r.due_on)}</span>
    </li>`,
      )
      .join('');
    parts.push(section('Upcoming renewals', `<ul>${rows}</ul>`, 'renewals'));
  }

  if (view.next_steps.length > 0) {
    parts.push(section('Next steps', `<ul>${view.next_steps.map(entryBlock).join('')}</ul>`, 'next'));
  }

  if (parts.length === 0) {
    parts.push(section(view.month_label, '<p class="empty">Nothing has been published for this month yet.</p>', 'empty'));
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(view.client)} | ${esc(view.month_label)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>${esc(view.client)}</h1>
<p class="sub">Client update for ${esc(view.month_label)}</p>
</header>
${parts.join('\n')}
<footer>Updated ${esc(view.generated_at.slice(0, 10))}. Please keep this link private.</footer>
</main>
</body>
</html>`;
}

export function renderPortalUnavailableHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Link unavailable</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header><h1>This link is no longer available</h1>
<p class="sub">It may have expired or been turned off. Ask for a new link.</p></header>
</main>
</body>
</html>`;
}
