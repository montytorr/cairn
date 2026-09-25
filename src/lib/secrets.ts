/**
 * Secret-shaped strings, refused before they are written (CAIRN-285).
 *
 * Everything Cairn stores is handed back to every agent that asks: `check`
 * and `know` return knowledge verbatim, notes and resolutions come back with
 * `show`, and whatever an agent reads is copied into its transcript. So a
 * credential written once is not stored in one place — it is replayed into
 * every session that touches the subject. The audit found a full `sbp_`
 * personal access token and two password lines in knowledge, returned to
 * anybody who searched for them.
 *
 * Two kinds of rule. Token formats with a fixed, documented prefix are
 * matched as such: they are unambiguous, and a false positive is close to
 * impossible. The `password: <value>` shape is a heuristic, so it only fires
 * on a value that looks like one — never on a placeholder (`<password>`,
 * `***`, `$DB_PASSWORD`, `process.env.X`), a type annotation (`token:
 * string`), a code expression, a path, or a pointer to where the secret
 * actually lives. The value is never returned, logged or echoed; the caller
 * is told the rule and the line, which is enough to find it.
 */

export type SecretHit = {
  /** Machine name of the rule, e.g. `github_token`. */
  pattern: string
  /** What it looked like, for a person. Never the value. */
  label: string
  /** 1-based line of the text the match starts on. */
  line: number
}

type TokenRule = { pattern: string; label: string; re: RegExp }

const TOKEN_RULES: TokenRule[] = [
  { pattern: 'supabase_token', label: 'a Supabase access token (sbp_…)', re: /\bsbp_[A-Za-z0-9]{20,}/ },
  { pattern: 'anthropic_key', label: 'an Anthropic API key (sk-ant-…)', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { pattern: 'openai_key', label: 'an API secret key (sk-…)', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ },
  { pattern: 'stripe_key', label: 'a Stripe secret key (sk_live_…)', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { pattern: 'github_token', label: 'a GitHub token (ghp_/gho_/…)', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { pattern: 'github_pat', label: 'a GitHub fine-grained token (github_pat_…)', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  // AWS's own documentation key is AKIAIOSFODNN7EXAMPLE; quoting it is fine.
  { pattern: 'aws_access_key', label: 'an AWS access key id (AKIA…)', re: /\b(?:AKIA|ASIA)(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b/ },
  { pattern: 'slack_token', label: 'a Slack token (xoxb-/xoxp-…)', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { pattern: 'private_key', label: 'a private key block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  // Header and payload are base64url JSON, so both open with `eyJ`. Long, so a
  // truncated example in prose (`eyJhbGci...`) does not trip it.
  { pattern: 'jwt', label: 'a JSON Web Token (eyJ….….…)', re: /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
]

/**
 * `password: hunter2`, `api_key = "…"`, `"token": "…"`, `**Password:** …`.
 * The key may carry a prefix (`client_secret`, `DB_PASSWORD`) but must end on
 * the word: `tokens: 500` and `secrets: inherit` are not assignments of one.
 */
const ASSIGNMENT =
  /([A-Za-z0-9_-]*?(?:password|passwd|pwd|secret|token|api[_-]?key))[*_`"']*[ \t]*[:=][*_`"']*[ \t]*([^\s]+)(?=([^\n]*))/gi

/** `scheme://user:pass@host` — a connection string with the password in it. */
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/([^\s:@/]+):([^\s@/]+)@[^\s/]/gi

const PLACEHOLDER_WORDS = new Set([
  'string', 'number', 'boolean', 'bool', 'str', 'int', 'any', 'unknown', 'object', 'bytes',
  'null', 'none', 'nil', 'undefined', 'true', 'false', 'required', 'optional', 'empty',
  'redacted', 'placeholder', 'example', 'changeme', 'password', 'passwd', 'secret', 'token',
  'hidden', 'masked', 'omitted', 'removed', 'elided', 'unset', 'default', 'todo', 'tbd', 'n/a',
])

/** A pointer to where the secret lives is exactly what should be written instead. */
const POINTER = /example|redacted|placeholder|dummy|sample|your[_-]|1password|bitwarden|keychain|vault|secrets\.|env\b|environ|getenv/i

const strip = (raw: string) =>
  raw.replace(/^[*_`"'([{]+/, '').replace(/[*_`"',;:.)\]}]+$/, '')

export const looksLikePlaceholder = (raw: string): boolean => {
  const trimmed = raw.trim()
  // Templating and references, judged before stripping removes the brackets:
  // `<password>`, `[token]`, `{{ secret }}`, `${DB_PASSWORD}`, `$TOKEN`, `%s`.
  if (/^[<[{$%]/.test(trimmed.replace(/^[`"'*]+/, ''))) return true
  const value = strip(trimmed)
  if (value.length < 6) return true
  if (/^\d+$/.test(value)) return true
  // One character repeated: `***`, `xxxxxx`, `......`, `------`.
  if (/^(.)\1*$/i.test(value)) return true
  if (PLACEHOLDER_WORDS.has(value.toLowerCase())) return true
  if (POINTER.test(value)) return true
  // Elided (`sk_live_...`) or self-describing (`'a-long-password'`).
  if (/\.\.\.|…/.test(trimmed) || /passw(?:or)?d|secret|token/i.test(value)) return true
  // An environment variable named rather than inlined: `GITHUB_TOKEN`.
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return true
  // Code, not a value: a call, a member access (`req.body.password`,
  // `process.env.X`), a type (`z.string()`), an arrow.
  if (/[()]|=>/.test(value)) return true
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(value)) return true
  // A path or a link says where it is, not what it is.
  if (/^(?:~|\.{1,2})?\//.test(value) || /^https?:/i.test(value)) return true
  return false
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length

export const detectSecret = (text: string): SecretHit | null => {
  if (!text) return null

  const hits: (SecretHit & { index: number })[] = []
  const consider = (pattern: string, label: string, index: number) => {
    hits.push({ pattern, label, line: lineAt(text, index), index })
  }

  for (const rule of TOKEN_RULES) {
    const match = rule.re.exec(text)
    if (match) consider(rule.pattern, rule.label, match.index)
  }

  for (const match of text.matchAll(ASSIGNMENT)) {
    const key = (match[1] ?? '').toLowerCase()
    const value = match[2] ?? ''
    // `token: stored in the vault` is a sentence about a token, not one.
    const prose = /^[A-Za-z]+$/.test(strip(value)) && /\S/.test(match[3] ?? '')
    if (!prose && !looksLikePlaceholder(value)) {
      consider('credential_assignment', `a value assigned to "${key}"`, match.index ?? 0)
      break
    }
  }

  for (const match of text.matchAll(URL_CREDENTIAL)) {
    const [, user = '', pass = ''] = match
    if (pass !== user && !looksLikePlaceholder(pass)) {
      consider('url_credential', 'a password inside a connection URL', match.index ?? 0)
      break
    }
  }

  // The earliest in the text, so the line reported is the first to fix.
  const [first] = hits.sort((a, b) => a.index - b.index)
  if (!first) return null
  return { pattern: first.pattern, label: first.label, line: first.line }
}

/**
 * The first secret in any of the named fields of a request body. Arrays are
 * checked element by element and objects as their JSON, so structured
 * payloads cannot carry what a plain field may not.
 */
export const findSecret = (
  body: unknown,
  fields: readonly string[],
): (SecretHit & { field: string }) | null => {
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  for (const field of fields) {
    const value = record[field]
    const texts =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string')
          : value && typeof value === 'object'
            ? [JSON.stringify(value, null, 1)]
            : []
    for (const text of texts) {
      const hit = detectSecret(text)
      if (hit) return { ...hit, field }
    }
  }
  return null
}

export const secretRefusal = (hit: SecretHit & { field: string }): string =>
  `Refused: ${hit.field} line ${hit.line} looks like it contains ${hit.label}. ` +
  'Cairn hands what it stores to every agent that asks, so a credential written here is ' +
  'replayed into every session that reads it. Write where the secret lives instead ' +
  '(an env var name, a vault path), and rotate it if it was real.'
