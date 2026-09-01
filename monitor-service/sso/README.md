# Cheaply SSO client registration

`tracking-web-client.json` is the non-secret registration contract for the
return-monitor dashboard. It deliberately mirrors the authorization-code,
PKCE, and RS256/JWKS flow already used by `presence.cheaply.fr`.

The central `cheaply-sso` Worker must add this exact client alongside the
existing `presence-web` branch:

```js
if (clientId === "tracking-web") {
  return {
    id: clientId,
    redirectUris: ["https://tracking.cheaply.fr/api/auth/callback"],
    secret: String(env.TRACKING_CLIENT_SECRET || "")
  };
}
```

Create one random secret with at least 32 characters and store the same value
as:

- `TRACKING_CLIENT_SECRET` in the central `cheaply-sso` Worker; and
- `MONITOR_TRACKING_CLIENT_SECRET` in GitHub Actions for this repository.

Never commit the secret. After deployment, verify that both `presence-web` and
`tracking-web` can complete login and that an unregistered redirect URI is
rejected.
