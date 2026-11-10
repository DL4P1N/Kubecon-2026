# Sign in with GitHub, Google or LinkedIn

Visitors can link a GitHub, Google or LinkedIn account to their profile. All we learn is a display
name and, where the provider gives them, a handle and a picture. There is no email scope and the
account is not a login: the Conference Companion session is still the one from registration.

## What is stored where

- **Browser only.** The linked accounts live in `localStorage` key `cc.linked.v1`:
  `{ "<provider>": { "displayName", "handle", "avatarUrl", "linkedAt" } }`, merged per provider.
- **Server: nothing durable.** The API keeps a random one-time `state` (plus the validated return path
  and, for Google, a PKCE verifier) in memory for 10 minutes, capped at 2000 entries. Provider access
  tokens are used once to read the profile and then dropped. Nothing is written to Elasticsearch, and codes,
  tokens and profile fields are never logged or put on spans.
- **Secrets.** Client secrets stay in the API's environment. The browser only sees the client id, in the
  redirect to the provider.

## Flow

1. The page links to `/api/auth/<provider>/start?return=/site/profile.html` (add `&app=1` from the iOS app).
2. The API answers 302 to the provider with `state`. Scopes: GitHub `read:user`; Google and LinkedIn `openid profile`.
3. The provider redirects to `/auth/<provider>/callback?code=&state=` (a React route, `web/src/pages/AuthCallback.tsx`).
4. That page POSTs `{code, state}` to `/api/auth/<provider>/callback`, stores the result in `cc.linked.v1`
   and replaces the location with the returned `return` path. With `app=1` it goes to
   `confcompanion://linked?provider=<p>&name=<displayName>` instead and shows a "Back to your profile" link.
5. Any failure shows a plain message and a link back to `/site/profile.html`.

Links for the site to use: `/api/auth/github/start`, `/api/auth/google/start`, `/api/auth/linkedin/start`
(each with an optional `?return=/site/...`). `GET /api/auth/providers` says which are enabled.

## Run it locally

Set, per provider (see `.env.example`): `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_OAUTH_REDIRECT_URI`,
and the same three with `GOOGLE_` and `LINKEDIN_`. A provider missing any of the three is disabled.
The API reads environment variables only and does not load `.env` itself, so for local use:

```sh
npm run build
cd api && node --env-file=../.env --import ./dist/telemetry/instrument.js dist/index.js   # API on :3000
npm run dev:web                                                                            # site on :5173
```

(`npm run dev:api` does not load `.env`; use the line above, or export the variables first.)

**Limit.** The redirect URIs in `.env` point at `http://localhost:5173/auth/<provider>/callback`, so sign-in
works only in a browser on the machine running the dev server, until redirect URIs for a hosted address are
registered with each provider and set in the environment.

## Hosting the sign-in backend elsewhere

The credentials may instead live in a separate hosted backend. It only has to implement this contract on the
same paths (the web app calls them relative to its own origin, so proxy or serve `/api/auth/*`).

- `GET /api/auth/providers` returns `{ "providers": [{ "id": "github"|"google"|"linkedin", "enabled": boolean }] }`.
- `GET /api/auth/:provider/start?return=<relative path>&app=1` returns 302 to the provider with a one-time
  `state`. `return` must be a same-origin relative path (starts with one `/`, no `//`, no backslash, no scheme;
  default `/site/profile.html`), otherwise 400. Unknown or disabled provider: 404.
- `POST /api/auth/:provider/callback` with `{ "code": string, "state": string }` validates and consumes the state
  (400 `invalid_state` if bad, expired or reused), exchanges the code with the secret, reads the profile and
  returns `{ "provider", "displayName", "handle"?, "avatarUrl"?, "return", "app" }`. No tokens in the response.
  Provider failure: 502 `{ "error": "provider_error", "message": "..." }`. Errors are `{ error, message }`.
- Browser side: `cc.linked.v1` as above. When `app` is true the page finishes at
  `confcompanion://linked?provider=<provider>&name=<encodeURIComponent(displayName)>`.
- The provider's registered redirect URI must be the web page `/auth/<provider>/callback` on the site's origin.
