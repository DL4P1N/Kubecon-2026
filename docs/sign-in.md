# Sign in with GitHub, Google or LinkedIn

Visitors can use a GitHub, Google or LinkedIn account to access the same attendee profile and schedule on any device. A new account receives a short-lived identity claim and creates its attendee profile through registration; returning accounts receive an attendee session directly. OAuth does not request email scope or store email.

## What is stored where

- **Browser:** provider display information in `localStorage` key `cc.linked.v1`: `{ "<provider>": { "displayName", "handle", "avatarUrl", "linkedAt" } }`. The attendee session token is held in `sessionStorage` as `cc.token`; new-account claims use `cc.identity-claim` temporarily and are cleared after registration.
- **Elasticsearch:** the `identities` index maps an HMAC-SHA256 of `<provider>:<provider subject>` to `attendee_id`, with `created_at` and `expires_at`. Raw provider subjects and email are never stored. `DELETE /api/me` removes identity links; the retention job deletes expired identity records with the attendee data.
- **API memory:** a random one-time `state` (plus the validated return path and, for Google, a PKCE verifier) for 10 minutes, capped at 2000 entries. Provider access tokens are used once to read the profile and then dropped. Codes, tokens, identity subjects, and profile fields are never logged or put on spans.
- **Secrets:** client secrets and `IDENTITY_HASH_KEY` stay in the API environment/Secret. `IDENTITY_HASH_KEY` must contain at least 32 characters whenever an OAuth provider is configured.

## Flow

1. The page links to `/api/auth/<provider>/start?return=/site/profile.html` (or a registration path with its conference query; add `&app=1` from the iOS app).
2. The API answers 302 to the provider with `state` and sets an HttpOnly, SameSite=Lax cookie (`cc_oauth`, 10 minutes, path `/api/auth`) holding a nonce stored with that state. The callback POST must carry the matching cookie, so a state started in one browser cannot be completed in another (400 `invalid_state`). Scopes: GitHub `read:user`; Google and LinkedIn `openid profile`.
3. The provider redirects to `/auth/<provider>/callback?code=&state=` (React route `web/src/pages/AuthCallback.tsx`). The page POSTs `{code, state}` to `/api/auth/<provider>/callback`.
4. A known account returns `{session:{token,expiresAt}}`; the page stores the attendee token and follows the validated return path. A new account returns `{claim:{token,expiresAt}}`; the claim expires after 15 minutes, and registration consumes it to create the identity link. A default profile return sends the new visitor to `/site/register.html?via=<provider>` so the chat starts from the provider display name; a visitor who already has a session on that page is sent on to `/schedule` instead of registering a second profile.
5. The callback also stores display-only provider information in `cc.linked.v1`. With `app=1`, it finishes at `confcompanion://linked?provider=<p>&name=<displayName>` and shows a fallback link.
6. Provider errors return 502; storage errors checking an identity return 503. Registration answers `400 invalid_identity_claim` for an expired or invalid claim and `409 already_registered` for a replayed one. The browser names the actual recovery (sign in again, or start again) rather than presenting a demo ticket.

`GET /api/auth/providers` says which provider apps are enabled. Start links: `/api/auth/github/start`, `/api/auth/google/start`, `/api/auth/linkedin/start` (each accepts an optional same-origin `?return=` path).

## Run it locally

Set, per provider (see `.env.example`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`, and the same three with `GOOGLE_` and `LINKEDIN_`. A provider missing any of the three is disabled. Set `IDENTITY_HASH_KEY` to a random value of at least 32 characters. The API reads environment variables only and does not load `.env` itself, so for local use:

```sh
npm run build
cd api && node --env-file=../.env --import ./dist/telemetry/instrument.js dist/index.js   # API on :3000
npm run dev:web                                                                            # site on :5173
```

(`npm run dev:api` does not load `.env`; use the line above, or export the variables first.)

The redirect URIs must point at `/auth/<provider>/callback` on the site's origin. For the toghouse deployment the origin is `https://conference-companion.ecan.pro` (served directly through the Cloudflare tunnel, no Vercel proxy), so the callbacks are `https://conference-companion.ecan.pro/auth/<provider>/callback`; register the same value in each provider app and set it as that provider's `*_OAUTH_REDIRECT_URI`. Provider-app creation is a manual operator task. Google consent must be External/In production for any Google account to sign in; LinkedIn must enable Sign In with LinkedIn using OpenID Connect.

## Hosting the sign-in backend elsewhere

The credentials may live in a separate hosted backend. It implements these paths on the same origin or is reached through a same-origin proxy:

- `GET /api/auth/providers` returns `{ "providers": [{ "id": "github"|"google"|"linkedin", "enabled": boolean }] }`.
- `GET /api/auth/:provider/start?return=<relative path>&app=1` returns 302 to the provider with one-time `state`. `return` is same-origin relative (starts with one `/`, no `//`, backslash, or scheme; default `/site/profile.html`); invalid return: 400. Unknown/disabled provider: 404.
- `POST /api/auth/:provider/callback` accepts `{ "code": string, "state": string }`, validates and consumes the state, exchanges the code, reads provider subject and display profile, then returns display fields plus exactly one of `session: {token, expiresAt}` or `claim: {token, expiresAt}`, and `return` / `app`. Provider tokens and subject are never returned. Provider failure: 502; identity storage failure: 503.
- `POST /api/register` accepts an optional `identityClaim`. It is audience-limited to identity claims and can be consumed once: an expired/invalid claim answers 400 `invalid_identity_claim`, a replayed one 409 `already_registered`. `DELETE /api/me` removes identity links along with the attendee's profile, schedule and entitlement.
