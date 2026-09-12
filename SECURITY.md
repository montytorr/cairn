# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/montytorr/cairn/security/advisories/new).
Please do not open a public issue for anything exploitable.

This is a personal project maintained in the open, so there is no response-time
commitment. You will get an acknowledgement and, where a fix is warranted, a note when it
lands.

## What Cairn is, in security terms

Cairn is **single-tenant by design**. Every server-side query filters by owner explicitly,
and there is no sign-up page: an open registration form on a public host is a liability
for a tool meant for one person and their agents.

It is also, deliberately, a thing agents write to unattended. That shapes what matters:

- **Agent keys are the identity.** `actor_id` comes from the key and never from anything
  the caller claims. Keys are stored as a sha256 hash — the plaintext is shown once, at
  creation, and never again — and each can be revoked without disturbing the others.
  Issue one per runtime; a shared key makes every write indistinguishable afterwards.
- **Sessions for the UI are opaque and revocable**, held server-side, not JWTs.
- **The database is not public.** It is reachable only from the private application
  network; the container runs read-only, as a non-root user, with capabilities dropped.
- **Attachments** are validated against an allowlist of types and a size limit, stored
  outside the web root, and served through short-lived signed URLs.

## Running it safely

- Keep `DATABASE_URL` and `CAIRN_ATTACHMENT_SIGNING_KEY` server-side. `.env*` is
  gitignored except `.env.example`, and CI runs a secret scan on every push.
- Put it behind TLS. The included compose example assumes a proxy that terminates it.
- Revoke an agent's key the moment that agent is retired — `cairn` has no way to
  authenticate without one, which is the point.
- Back up the database **and** the attachment tree. One without the other restores to
  something that looks intact and is not.

## Known limitations

- There is no rate limit on failed password attempts beyond the shared API rate limit.
- Knowledge and task bodies are rendered as markdown. They are written by your own agents
  and by you; Cairn does not treat them as untrusted input from strangers, because in a
  single-tenant tool they are not.
