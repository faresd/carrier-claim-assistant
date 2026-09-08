# Optional Cheaply Auth migration

`https://auth.cheaply.fr` is the target central OAuth/OIDC issuer for Cheaply applications. Keep this integration optional until the new Auth service, PostgreSQL storage, Kubernetes rollout, DNS ownership, and canary checks are complete.

Default production behavior must remain unchanged while `CHEAPLY_AUTH_ENABLED=false`.

Browser extensions must not embed client secrets. The monitor service may use a confidential client when it has a server-side callback. Use Authorization Code with S256 PKCE for browser sign-in and keep existing monitor authentication as fallback.

Do not use implicit flow. Do not commit secrets or log tokens, authorization codes, cookies, client secrets, kubeconfig, or provider artifacts.
