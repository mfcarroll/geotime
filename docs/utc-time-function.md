# `get-utc-time` — the UTC reference function

A ~20-line Cloud Function that returns the current UTC time. It is what
`syncClock()` in `src/time.ts` calls, and it exists because **a correct timezone
still renders the wrong time if the device's clock is wrong** — which is the
failure this whole app was built around.

> **No source control, no CI.** It was created directly in the Google Cloud
> console's inline editor and has never lived in a repository. This file is the
> only record of it. Edit it in the console; there is no deploy pipeline to run.

## Where it lives

| | |
| --- | --- |
| Service | `get-utc-time` |
| Project | `world-clock-473806` (project number `100547663673`) |
| Region | `us-west1` |
| URL | `https://get-utc-time-100547663673.us-west1.run.app/` |
| Entry point | `getTime` |
| Auth | none — public, unauthenticated |
| Console | [Run → get-utc-time → source](https://console.cloud.google.com/run/detail/us-west1/get-utc-time/source?project=world-clock-473806) |

Note the project is **not** whatever `gcloud config get-value project` reports
by default; pass `--project=world-clock-473806` explicitly.

```bash
gcloud run services describe get-utc-time \
  --region=us-west1 --project=world-clock-473806
```

## Source

Verbatim, as deployed:

```js
/**
 * A simple Google Cloud Function to return the current UTC time.
 */
exports.getTime = (req, res) => {
  // Set CORS headers to allow requests from your web app
  res.set('Access-Control-Allow-Origin', '*');

  // Handle preflight requests for CORS
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send(''); return;
  }

  // Send the current time as an ISO 8601 string
  res.status(200).json({
    dateTime: new Date().toISOString(),
  });
};
```

Response:

```json
{ "dateTime": "2026-09-02T04:10:51.682Z" }
```

`Access-Control-Allow-Origin: *` is what lets the browser build call it — unlike
`api.rccl.com`, which sends no CORS headers at all and is therefore reachable
only from native.

## How the app uses it

`syncClock()` fetches it once at launch and passes the result to
`noteServerTime()`, which sets `state.timeOffset` — the correction added to
`Date.now()` everywhere a time is rendered. A difference under 500 ms is treated
as zero, since below that it is indistinguishable from round-trip latency.

On failure the offset resets to 0, i.e. the device clock is used as-is. That is a
deliberate floor rather than a fix: there is nothing better to fall back to.

## Second source, since 1.4.0

Ship time added a second UTC reference for free. Every `api.rccl.com` response
carries a `date` header, and it is fed into the same `noteServerTime()` path.

At sea that is the *better* of the two: it is reachable from a ship's network
without buying an internet package, and the request is being made anyway. This
function stays the general path, because no RCCL call happens for the large
majority of users who never touch a ship — so it **cannot be retired**, even
though it is now the less useful source in the one situation the app was built
for.

## If it ever needs replacing

Nothing about the contract is special: any endpoint returning
`{"dateTime": "<ISO 8601>"}` with permissive CORS will do. The URL is a single
constant, `GCF_URL` in `src/time.ts`. Worth knowing because an unversioned,
console-authored function in a personal project is exactly the kind of thing that
goes missing.
