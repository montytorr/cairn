import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release validation boundary', () => {
  it('allows production deploy only after the main CI workflow succeeds', () => {
    const deploy = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).toContain('workflow_run:')
    expect(deploy).toContain('workflows: [ci]')
    expect(deploy).toContain("workflow_run.conclusion == 'success'")
    expect(deploy).toContain("workflow_run.event == 'push'")
    expect(deploy).toContain("workflow_run.head_branch == 'main'")
    expect(deploy).toContain('workflow_run.head_repository.full_name == github.repository')
    expect(deploy).not.toContain('workflow_dispatch:')
    expect(deploy).not.toMatch(/\n\s+push:\s*\n/)

    const workflowRun = {
      conclusion: 'success', event: 'pull_request', head_branch: 'main',
      head_repository: { full_name: 'attacker/cairn' },
    }
    const repository = 'montytorr/cairn'
    const canDeploy = workflowRun.conclusion === 'success' &&
      workflowRun.event === 'push' &&
      workflowRun.head_branch === 'main' &&
      workflowRun.head_repository.full_name === repository
    expect(canDeploy).toBe(false)
  })

  it('deploys only the commit main is on, so a late CI run cannot roll it back (CAIRN-318)', () => {
    const deploy = readFileSync(join(process.cwd(), '.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).toMatch(/\n  gate:\n/)
    expect(deploy).toContain('repos/$REPO/commits/main')
    expect(deploy).toMatch(/\n  deploy:\n    needs: gate\n    if: needs\.gate\.outputs\.current == 'true'/)
  })

  it('runs the PostgreSQL integrity suite as a local merge check, not in GitHub CI', () => {
    const ci = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
    expect(ci).not.toMatch(/\n  integration:\n/)
    expect(ci).not.toMatch(/run: npm run (db:migrate|test:integration)/)
    expect(ci).toMatch(/\n  image:\n/)

    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts['test:integration:local']).toContain('scripts/with-throwaway-postgres.sh')
    expect(pkg.scripts['test:integration:local']).toContain('npm run db:migrate && npm run test:integration')

    const wrapper = readFileSync(join(process.cwd(), 'scripts/with-throwaway-postgres.sh'), 'utf8')
    expect(wrapper).toContain('postgres:16')
    expect(wrapper).toContain('--tmpfs /var/lib/postgresql/data')
    expect(wrapper).toContain('-p 127.0.0.1::5432')
    expect(wrapper).toMatch(/trap cleanup EXIT/)

    const { checks } = JSON.parse(readFileSync(join(process.cwd(), '.drove.json'), 'utf8'))
    expect(checks.indexOf('npm run test:integration:local')).toBeGreaterThan(checks.indexOf('npm run build'))
    expect(checks.indexOf('npm run build')).toBeGreaterThanOrEqual(0)
  })
})
