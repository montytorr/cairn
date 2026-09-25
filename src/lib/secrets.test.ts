import { describe, expect, it } from 'vitest'
import { detectSecret, findSecret, looksLikePlaceholder, secretRefusal } from './secrets'

// Assembled at runtime so this file does not itself look like it leaks
// anything to a repository scanner.
const fake = (prefix: string, n: number, alphabet = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z') =>
  prefix + Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join('')

describe('detectSecret: token formats', () => {
  const cases: [string, string][] = [
    ['supabase_token', fake('sbp_', 40, '0123456789abcdef')],
    ['anthropic_key', fake('sk-ant-api03-', 60)],
    ['openai_key', fake('sk-proj-', 48)],
    ['stripe_key', fake('sk_live_', 24)],
    ['github_token', fake('ghp_', 36)],
    ['github_token', fake('gho_', 36)],
    ['github_pat', fake('github_pat_', 60)],
    ['aws_access_key', fake('AKIA', 16, 'ABCDEFGHIJKLMNOP2345')],
    ['slack_token', fake('xoxb-', 30, '0123456789')],
    ['private_key', `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----\nabc`],
    ['jwt', `${fake('eyJ', 30)}.${fake('eyJ', 40)}.${fake('', 43)}`],
  ]
  for (const [pattern, secret] of cases) {
    it(`finds ${pattern} and reports the rule, not the value`, () => {
      const hit = detectSecret(`some context\nthe value is ${secret} here`)
      expect(hit?.pattern).toBe(pattern)
      expect(hit?.line).toBe(2)
      expect(JSON.stringify(hit)).not.toContain(secret.slice(4, 20))
    })
  }

  it('leaves the documented AWS example key and short prose mentions alone', () => {
    expect(detectSecret('e.g. AKIAIOSFODNN7EXAMPLE from the AWS docs')).toBeNull()
    expect(detectSecret('keys start with sk- or sbp_ and tokens with ghp_')).toBeNull()
    expect(detectSecret('a JWT looks like eyJhbGciOi...')).toBeNull()
    expect(detectSecret('the sk-learn model and scikit-learn')).toBeNull()
  })
})

describe('detectSecret: credential assignments', () => {
  it.each([
    'password: hunter2x',
    'Password: Tr0ub4dor&3',
    '**Password:** s3cr3tvalue',
    'DB_PASSWORD=pa55w0rd!',
    'api_key = "not-a-real-value-42"',
    '{"token": "f00dbabe12345678"}',
    'client_secret: not-a-real-value-43',
    'pwd=Winter2026',
    'token: abc  pwd=Winter2026',
  ])('refuses %s', (text) => {
    expect(detectSecret(text)?.pattern).toBe('credential_assignment')
  })

  it.each([
    'password: <password>',
    'password: ***',
    'password: ******',
    'password: xxxxxxxx',
    'token: $GITHUB_TOKEN',
    'token=${CAIRN_API_KEY}',
    'api_key: process.env.OPENAI_API_KEY',
    'secret: os.environ["X"]',
    'password: string',
    'token: z.string().min(1)',
    'password: req.body.password',
    'apiKey: options.apiKey',
    'token: GITHUB_TOKEN',
    'password: [redacted]',
    'password: see 1Password',
    'token: stored in the vault',
    'max_tokens: 4096',
    'tokens: 500',
    'secrets: inherit',
    'token_count = 1200',
    'pwd: ~/project',
    'secret: https://vault.example.com/x',
    'password: {{ db_password }}',
    'password = your-password-here',
    'password: changeme',
    'token: null',
    'export CAIRN_API_KEY=sk_live_...',
    "CAIRN_OPERATOR_PASSWORD='a-long-password'",
  ])('accepts %s', (text) => {
    expect(detectSecret(text)).toBeNull()
  })
})

describe('detectSecret: connection URLs', () => {
  it('refuses a password inside a URL', () => {
    expect(detectSecret('postgres://cairn:hunter2hunter2@db:5432/cairn')?.pattern).toBe('url_credential')
  })

  it('accepts placeholder and env-templated URLs', () => {
    expect(detectSecret('postgres://user:password@localhost/db')).toBeNull()
    expect(detectSecret('postgres://postgres:postgres@localhost/db')).toBeNull()
    expect(detectSecret('postgres://cairn:${PGPASSWORD}@db/cairn')).toBeNull()
    expect(detectSecret('https://github.com/montytorr/cairn')).toBeNull()
  })
})

describe('findSecret', () => {
  it('names the field, and reads arrays and objects', () => {
    const secret = fake('ghp_', 36)
    expect(findSecret({ title: 'ok', body: `x ${secret}` }, ['title', 'body'])?.field).toBe('body')
    expect(findSecret({ facts: ['fine', secret] }, ['facts'])?.field).toBe('facts')
    expect(findSecret({ payload: { token: 'f00dbabe12345678' } }, ['payload'])?.field).toBe('payload')
    expect(findSecret({ body: secret }, ['title'])).toBeNull()
  })

  it('writes a refusal that never carries the value', () => {
    const secret = fake('sbp_', 40, '0123456789abcdef')
    const hit = findSecret({ body: secret }, ['body'])
    expect(hit).not.toBeNull()
    const message = secretRefusal(hit!)
    expect(message).toContain('body line 1')
    expect(message).not.toContain(secret)
  })
})

describe('looksLikePlaceholder', () => {
  it('is false for something that reads as a real value', () => {
    expect(looksLikePlaceholder('hunter2x')).toBe(false)
  })
})
