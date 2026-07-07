import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  assertLinkedInAuthenticated,
  normalizeWhitespace,
  unwrapEvaluateResult,
} from './shared.js';

const LINKEDIN_DOMAIN = 'linkedin.com';

// linkedin whoami — identify the logged-in account. Returns the stable member
// id (fsd_profile ACoAA… — the SAME token that shows up as sender_urn in
// message-listen, so it's the natural per-account key / "account_id equivalent"),
// plus the public_identifier (vanity) and display name. The managed service
// calls this once at startup (adapter is free before the listener takes it).
cli({
  site: 'linkedin',
  name: 'whoami',
  access: 'read',
  description: 'Identify the logged-in LinkedIn account: member_id (fsd_profile), public_identifier, name',
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [],
  columns: ['member_id', 'public_identifier', 'name', 'ok', 'error'],
  func: async (page) => {
    // The COOKIE-strategy pre-navigation already lands us on linkedin.com
    // (→ /feed/ when logged in). Do NOT goto('/feed/') again — navigating to
    // the URL we're already on gets "Navigation rejected" by the extension.
    // /voyager/api/me is a same-origin fetch, so any linkedin.com page works.
    await page.wait(2);
    await assertLinkedInAuthenticated(page, 'linkedin whoami');

    // /voyager/api/me carries the miniProfile: entityUrn (fs_miniProfile:ACoAA…),
    // publicIdentifier, firstName, lastName — same-origin fetch, one round-trip.
    const raw = unwrapEvaluateResult(await page.evaluate(String.raw`(async () => {
      try {
        const csrfM = document.cookie.match(/JSESSIONID="?([^";]+)/);
        const csrf = csrfM ? csrfM[1] : '';
        const r = await fetch('/voyager/api/me', {
          headers: { 'csrf-token': csrf, 'accept': 'application/json' },
          credentials: 'include',
        });
        const t = await r.text();
        return t.slice(0, 30000);
      } catch (e) { return 'ERR:' + (e && e.message ? e.message : e); }
    })()`));

    if (!raw || String(raw).startsWith('ERR:')) {
      return [{ member_id: '', public_identifier: '', name: '', ok: false, error: 'me_fetch_failed: ' + String(raw || '').slice(0, 80) }];
    }

    const member = (raw.match(/(?:fs_miniProfile|fsd_profile)(?:%3A|:)(ACoAA[A-Za-z0-9_-]+)/) || [])[1] || '';
    const publicId = (raw.match(/"publicIdentifier":"([^"]+)"/) || [])[1] || '';
    const firstName = (raw.match(/"firstName":"([^"]+)"/) || [])[1] || '';
    const lastName = (raw.match(/"lastName":"([^"]+)"/) || [])[1] || '';
    const name = normalizeWhitespace([firstName, lastName].filter(Boolean).join(' '));

    if (!member) {
      return [{ member_id: '', public_identifier: publicId, name, ok: false, error: 'member_id_not_found' }];
    }
    return [{ member_id: member, public_identifier: publicId, name, ok: true, error: '' }];
  },
});
