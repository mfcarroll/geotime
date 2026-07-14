// Submit the latest processed TestFlight build for the current package.json
// version to App Store review, releasing automatically after approval.
//
// Runs in CI after Xcode Cloud uploads a build (polls until it appears), and
// is safe to re-run: if the version is already in review or released it exits
// cleanly without side effects.
//
// Required env:
//   ASC_KEY_ID, ASC_ISSUER_ID
//   ASC_PRIVATE_KEY (PEM contents) or ASC_PRIVATE_KEY_PATH (file path)
// Optional env:
//   ASC_APP_ID (defaults to GeoTime), RELEASE_NOTES (What's New text)

import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_ID = process.env.ASC_KEY_ID;
const ISSUER_ID = process.env.ASC_ISSUER_ID;
const APP_ID = process.env.ASC_APP_ID || '6753636878';
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const NOTES = process.env.RELEASE_NOTES || 'Bug fixes and performance improvements.';
const keyPem = process.env.ASC_PRIVATE_KEY || fs.readFileSync(process.env.ASC_PRIVATE_KEY_PATH, 'utf8');
if (!KEY_ID || !ISSUER_ID || !keyPem) throw new Error('ASC_KEY_ID, ASC_ISSUER_ID and a private key are required');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mintToken = () => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
  const sig = crypto
    .sign('sha256', Buffer.from(`${header}.${payload}`), { key: crypto.createPrivateKey(keyPem), dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${header}.${payload}.${sig}`;
};

async function api(path, method = 'GET', body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${mintToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}\n${text}`);
  return text ? JSON.parse(text) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. Wait for a processed build of this marketing version ---------------
console.log(`Releasing GeoTime ${VERSION}`);
let build = null;
const deadline = Date.now() + 45 * 60 * 1000;
while (!build) {
  const res = await api(
    `/v1/builds?filter[app]=${APP_ID}&filter[preReleaseVersion.version]=${VERSION}&filter[processingState]=VALID&sort=-uploadedDate&limit=1`,
  );
  build = res.data[0] || null;
  if (!build) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for a processed ${VERSION} build`);
    console.log(`No processed ${VERSION} build yet; waiting 60s...`);
    await sleep(60_000);
  }
}
console.log(`Using build ${build.attributes.version} (uploaded ${build.attributes.uploadedDate})`);

// --- 2. Find or create the App Store version -------------------------------
const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const IN_FLIGHT = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_APP_STORE', 'IN_REVIEW'];
const versions = (
  await api(`/v1/apps/${APP_ID}/appStoreVersions?fields[appStoreVersions]=versionString,appStoreState,releaseType&limit=10`)
).data;

const existing = versions.find((v) => v.attributes.versionString === VERSION);
if (existing && !EDITABLE.includes(existing.attributes.appStoreState)) {
  console.log(`Version ${VERSION} is already ${existing.attributes.appStoreState}; nothing to do.`);
  process.exit(0);
}

let version = existing || versions.find((v) => EDITABLE.includes(v.attributes.appStoreState));
if (version) {
  await api(`/v1/appStoreVersions/${version.id}`, 'PATCH', {
    data: { type: 'appStoreVersions', id: version.id, attributes: { versionString: VERSION, releaseType: 'AFTER_APPROVAL' } },
  });
  console.log(`Reusing editable App Store version record (${version.id})`);
} else {
  version = (
    await api('/v1/appStoreVersions', 'POST', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString: VERSION, releaseType: 'AFTER_APPROVAL' },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    })
  ).data;
  console.log(`Created App Store version ${VERSION} (${version.id})`);
}

// --- 3. Attach the build and set What's New --------------------------------
await api(`/v1/appStoreVersions/${version.id}/relationships/build`, 'PATCH', {
  data: { type: 'builds', id: build.id },
});
console.log('Build attached.');

const locs = (await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=20`)).data;
for (const loc of locs) {
  await api(`/v1/appStoreVersionLocalizations/${loc.id}`, 'PATCH', {
    data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: { whatsNew: NOTES } },
  });
}
console.log(`What's New set on ${locs.length} localization(s).`);

// --- 4. Submit for review ---------------------------------------------------
const subs = (await api(`/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=5`)).data;
if (subs.some((s) => ['WAITING_FOR_REVIEW', 'IN_REVIEW'].includes(s.attributes.state))) {
  console.log('A review submission is already in flight; nothing to do.');
  process.exit(0);
}
let submission = subs.find((s) => s.attributes.state === 'READY_FOR_REVIEW');
if (!submission) {
  submission = (
    await api('/v1/reviewSubmissions', 'POST', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: APP_ID } } } },
    })
  ).data;
}
try {
  await api('/v1/reviewSubmissionItems', 'POST', {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
      },
    },
  });
} catch (e) {
  if (!String(e).includes('409')) throw e; // already added to this submission
}
await api(`/v1/reviewSubmissions/${submission.id}`, 'PATCH', {
  data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
});
console.log(`Submitted ${VERSION} (build ${build.attributes.version}) for App Store review; releases automatically on approval.`);
