/**
 * Client portal (T707): link signing, expiry and revocation, visibility
 * filtering in the view builder, and HTML escaping.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { mockTaskpilotPaths } from './helpers/mock-paths';
import { useMockedDb } from './helpers/mock-db';

mockTaskpilotPaths();

import { createDeliveryItem, updateDeliveryItem } from '@/main/delivery/repository';
import { createPortalEntry, updatePortalEntry } from '@/main/portal/entries';
import { esc, renderPortalHtml } from '@/main/portal/html';
import {
  createPortalLink,
  resetPortalSecretCache,
  revokePortalLink,
  signPortalToken,
  verifyPortalToken,
} from '@/main/portal/links';
import { buildPortalView } from '@/main/portal/view';
import { createRenewal } from '@/main/renewals/repository';
import { isAuthAllowlisted } from '@/main/server/middleware/auth';
import { redactPortalToken } from '@/main/server';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function tokenOf(url: string): string {
  return url.split('/portal/')[1]!;
}

describe('portal link signing', () => {
  useMockedDb();
  afterEach(() => {
    delete process.env.TASKPILOT_PORTAL_SECRET;
    resetPortalSecretCache();
  });

  it('verifies a fresh link and resolves its client', () => {
    const link = createPortalLink({ client: 'Practice A', expires_in_days: 30 }, NOW);
    expect(link.status).toBe('active');
    const res = verifyPortalToken(tokenOf(link.url), NOW + DAY);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.link.client).toBe('Practice A');
  });

  it('rejects expired, revoked, tampered and malformed tokens', () => {
    const link = createPortalLink({ client: 'Practice A', expires_in_days: 7 }, NOW);
    const token = tokenOf(link.url);

    expect(verifyPortalToken(token, NOW + 8 * DAY)).toEqual({ ok: false, reason: 'expired' });

    const [id, exp, sig] = token.split('.');
    // Extending the expiry breaks the signature.
    expect(verifyPortalToken(`${id}.${Number(exp) + 86_400}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // Flipping a signature character.
    const flipped = sig!.startsWith('A') ? `B${sig!.slice(1)}` : `A${sig!.slice(1)}`;
    expect(verifyPortalToken(`${id}.${exp}.${flipped}`, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyPortalToken('nope', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyPortalToken(`${token}x`, NOW)).toEqual({ ok: false, reason: 'malformed' });

    revokePortalLink(link.id, NOW);
    expect(verifyPortalToken(token, NOW)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects a validly signed token whose link row does not exist', () => {
    const exp = new Date(NOW + DAY).toISOString();
    expect(verifyPortalToken(signPortalToken('ghostlink1234567', exp), NOW)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('invalidates every link when the secret changes', () => {
    const link = createPortalLink({ client: 'Practice A' }, NOW);
    process.env.TASKPILOT_PORTAL_SECRET = 'x'.repeat(40);
    resetPortalSecretCache();
    expect(verifyPortalToken(tokenOf(link.url), NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('bounds expiry', () => {
    expect(() => createPortalLink({ client: 'A', expires_in_days: 0 }, NOW)).toThrow();
    expect(() => createPortalLink({ client: 'A', expires_in_days: 400 }, NOW)).toThrow();
  });

  it('bypasses bearer auth only for /portal/ and redacts tokens in logs', () => {
    expect(isAuthAllowlisted('/portal/abc.123.sig')).toBe(true);
    expect(isAuthAllowlisted('/portalx')).toBe(false);
    expect(isAuthAllowlisted('/api/portal/links')).toBe(false);
    expect(redactPortalToken('/portal/abc.123.sig/view.json')).toBe('/portal/[REDACTED]/view.json');
    expect(redactPortalToken('/api/portal/links')).toBe('/api/portal/links');
  });
});

describe('portal view visibility', () => {
  useMockedDb();

  function seed(): void {
    const mk = (title: string, extra: Parameters<typeof createDeliveryItem>[0] extends infer T ? Partial<T> : never) =>
      createDeliveryItem(
        {
          title,
          description: 'INTERNAL description',
          owner_type: 'contractor',
          owner_name: 'Maria Internal',
          client: 'Practice A',
          ...extra,
        },
        NOW - 20 * DAY,
      );
    const doneThisMonth = mk('Visible done this month', { client_visible: true, deliverable_url: 'https://example.com/report' });
    updateDeliveryItem(doneThisMonth.id, { status: 'done' }, NOW - DAY);
    const doneLastMonth = mk('Visible done last month', { client_visible: true });
    updateDeliveryItem(doneLastMonth.id, { status: 'done' }, NOW - 30 * DAY);
    mk('Visible in progress', { client_visible: true, status: 'in_progress', deadline: '2026-11-01T00:00:00.000Z' });
    mk('Visible waiting', { client_visible: true, status: 'waiting_on_client' });
    mk('Visible cancelled', { client_visible: true, status: 'cancelled' });
    mk('Hidden in progress', { status: 'in_progress' });
    mk('Other client item', { client: 'Practice B', client_visible: true });

    createRenewal({ client: 'Practice A', item_type: 'dea', label: 'Visible DEA', due_date: '2026-12-01', client_visible: true, notes: 'INTERNAL note' });
    createRenewal({ client: 'Practice A', item_type: 'baa', label: 'Hidden BAA', due_date: '2026-12-01' });
    createRenewal({ client: 'Practice A', item_type: 'state_license', label: 'Far license', due_date: '2028-12-01', client_visible: true });
    createRenewal({ client: 'Practice A', item_type: 'site_rescan', label: 'Inactive rescan', due_date: '2026-11-01', client_visible: true, active: false });

    createPortalEntry({ client: 'Practice A', kind: 'monthly_note', title: 'October note', body: 'Line one', client_visible: true, month: '2026-10' }, NOW);
    createPortalEntry({ client: 'Practice A', kind: 'monthly_note', title: 'September note', client_visible: true, month: '2026-09' }, NOW);
    createPortalEntry({ client: 'Practice A', kind: 'finding', title: 'Draft finding', month: '2026-10' }, NOW);
    createPortalEntry({ client: 'Practice A', kind: 'deliverable', title: 'Scan report', url: 'https://example.com/scan', client_visible: true }, NOW);
    createPortalEntry({ client: 'Practice A', kind: 'next_step', title: 'Sign the BAA', client_visible: true }, NOW);
    const done = createPortalEntry({ client: 'Practice A', kind: 'next_step', title: 'Finished step', client_visible: true }, NOW);
    updatePortalEntry(done.id, { done: true }, NOW);
    createPortalEntry({ client: 'Practice B', kind: 'next_step', title: 'Other client step', client_visible: true }, NOW);
  }

  it('shows only published items for the client and month', () => {
    seed();
    const view = buildPortalView('Practice A', {}, NOW);
    expect(view.month).toBe('2026-10');
    expect(view.month_label).toBe('October 2026');
    expect(view.work.completed.map((i) => i.title)).toEqual(['Visible done this month']);
    expect(view.work.completed[0]).toMatchObject({ status: 'completed', completed_on: '2026-10-14', url: 'https://example.com/report' });
    expect(view.work.in_progress.map((i) => [i.title, i.status])).toEqual(
      expect.arrayContaining([
        ['Visible in progress', 'in_progress'],
        ['Visible waiting', 'waiting_on_you'],
      ]),
    );
    expect(view.work.in_progress).toHaveLength(2);
    expect(view.renewals.map((r) => r.label)).toEqual(['Visible DEA']);
    expect(view.renewals[0]).toMatchObject({ item_type_label: 'DEA registration', state: 'due_soon', due_on: '2026-12-01' });
    expect(view.monthly_notes.map((e) => e.title)).toEqual(['October note']);
    expect(view.deliverables.map((e) => e.title)).toEqual(['Scan report']);
    expect(view.next_steps.map((e) => e.title)).toEqual(['Sign the BAA']);
  });

  it('never carries internal fields', () => {
    seed();
    const json = JSON.stringify(buildPortalView('Practice A', {}, NOW));
    for (const leak of ['INTERNAL', 'Maria', 'Hidden', 'Other client', 'Draft finding', 'owner', 'description', '"notes"']) {
      expect(json).not.toContain(leak);
    }
  });

  it('can show a past month', () => {
    seed();
    const view = buildPortalView('Practice A', { month: '2026-09' }, NOW);
    expect(view.work.completed.map((i) => i.title)).toEqual(['Visible done last month']);
    expect(view.monthly_notes.map((e) => e.title)).toEqual(['September note']);
  });

  it('refuses unsafe URLs on entries', () => {
    expect(() =>
      createPortalEntry({ client: 'A', kind: 'deliverable', title: 'x', url: 'javascript:alert(1)' }, NOW),
    ).toThrow(/http/);
  });
});

describe('portal HTML', () => {
  it('escapes everything and drops unsafe links', () => {
    expect(esc(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    const html = renderPortalHtml({
      client: '<script>alert(1)</script>',
      month: '2026-10',
      month_label: 'October 2026',
      generated_at: new Date(NOW).toISOString(),
      work: {
        completed: [{ title: 'Done <b>', status: 'completed', completed_on: '2026-10-02', due_on: null, url: 'javascript:alert(1)' }],
        in_progress: [],
      },
      deliverables: [],
      renewals: [],
      next_steps: [],
      monthly_notes: [{ kind: 'monthly_note', title: 'Note', body: 'a\n\nb <i>', url: null }],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Done &lt;b&gt;');
    expect(html).toContain('<p>b &lt;i&gt;</p>');
  });
});
