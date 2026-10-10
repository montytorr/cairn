/**
 * The dry-run report, as text for a person and as an object for a test or a
 * file. Both come from the same value so they cannot disagree.
 */

/** `postgresql://user:pass@host:5432/db` without the password. */
export const maskUrl = (url) => {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '(not a URL)'
  }
}

const pad = (value, width) => String(value).padEnd(width)

const table = (rows, columns) => {
  if (!rows.length) return ['  (none)']
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)))
  const line = (cells) => `  ${cells.map((cell, i) => pad(cell, widths[i])).join('  ').trimEnd()}`
  return [line(columns.map((c) => c.label)), ...rows.map((r) => line(columns.map((c) => c.get(r) ?? '')))]
}

export const buildReport = ({ plan, mode, source, target, verification = null, written = 0, blocked = [], fileStats = null }) => {
  const errors = [...blocked, ...(plan?.errors ?? [])]
  return {
    mode,
    verdict: errors.length ? 'blocked' : mode === 'apply' ? 'applied' : 'ready',
    source: maskUrl(source),
    target: maskUrl(target),
    errors,
    warnings: plan?.warnings ?? [],
    notes: plan?.notes ?? [],
    owner: plan?.owner ?? null,
    counts: plan?.counts ?? null,
    users: plan?.users ?? [],
    stages: plan?.stages ?? [],
    tags: plan?.tags ?? [],
    projects: plan?.projects ?? [],
    home: plan?.home ?? null,
    subjects: plan?.subjects ?? null,
    todos: plan?.todos ?? null,
    logKinds: plan?.logKinds ?? {},
    skipped: plan?.skipped ?? [],
    rewrites: plan?.rewrites ?? null,
    files: fileStats,
    verification,
    filesCopied: written,
  }
}

export const renderReport = (r) => {
  const out = []
  const title =
    r.mode === 'apply'
      ? r.verdict === 'applied'
        ? 'Croft import: APPLIED'
        : 'Croft import: REFUSED (nothing written)'
      : `Croft import: DRY RUN (${r.verdict === 'ready' ? 'would succeed' : 'blocked'}; nothing written)`
  out.push(title, `  source  ${r.source}`, `  target  ${r.target}`, '')

  if (r.errors.length) {
    out.push('Blocked:', ...r.errors.map((e) => `  - ${e}`), '')
  }
  if (r.counts) {
    out.push('Rows per table:')
    out.push(
      ...table(
        Object.entries(r.counts).map(([name, c]) => ({ name, ...c })),
        [
          { label: 'table', get: (c) => c.name },
          { label: 'in croft', get: (c) => c.source },
          { label: 'written', get: (c) => c.insert ?? 0 },
          { label: 'reused', get: (c) => c.reuse ?? '' },
          { label: 'updated', get: (c) => c.update ?? '' },
          { label: 'skipped', get: (c) => c.skipped ?? '' },
        ],
      ),
      '',
    )

    out.push(`Users (${r.users.length}); passwords come across as hashes, agent keys do not:`)
    out.push(
      ...table(r.users, [
        { label: 'email', get: (u) => u.email },
        { label: 'role', get: (u) => u.role },
        { label: 'action', get: (u) => u.action },
        { label: 'note', get: (u) => u.note },
      ]),
      '',
    )
    if (r.owner) out.push(`Projects are owned by ${r.owner.email}.`, '')

    out.push('Stages:')
    out.push(
      ...table(r.stages, [
        { label: 'name', get: (s) => s.name },
        { label: 'action', get: (s) => s.action },
        { label: 'detail', get: (s) => s.detail },
      ]),
      '',
    )
    out.push(`Tags: ${r.tags.map((t) => `${t.name} (${t.action})`).join(', ') || '(none)'}`, '')

    out.push('Projects created:')
    out.push(
      ...table(r.projects, [
        { label: 'key', get: (p) => p.key },
        { label: 'name', get: (p) => p.name },
        { label: 'hand-off', get: (p) => p.handoff ?? '' },
        { label: 'todos', get: (p) => r.todos?.perProject?.[p.key] ?? 0 },
        { label: 'how', get: (p) => p.source },
      ]),
      '',
    )

    const s = r.subjects
    out.push(
      `Subjects: ${s.total} (${s.archived} archived), S-n becomes LAB-n with the same number.`,
      `  highest number ${s.highest}, Croft's counter ${s.croftCounter}; the counter ends at ${s.counterAfter}, so the next subject is LAB-${s.counterAfter + 1}.`,
      `  numbers never used or deleted: ${s.gaps.length ? s.gaps.map((n) => `S-${n}`).join(', ') : 'none'}`,
      '',
    )

    const t = r.todos
    out.push(
      `Todos: ${t.total}`,
      `  by status:  ${Object.entries(t.statuses).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`,
      `  hand-offs:  ${Object.entries(t.handoff.byTracker).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} (open ${t.handoff.open}, ended ${t.handoff.ended}; ${t.handoff.derivedUrls} cairn URLs derived)`,
      `  claims cleared: ${t.claimsCleared}${t.releasedToTodo ? `, ${t.releasedToTodo} doing todos back to todo` : ''}`,
      '',
    )
    if (Object.keys(r.logKinds).length) {
      out.push(`Subject log kinds: ${Object.entries(r.logKinds).map(([k, v]) => `${k} ${v}`).join(', ')}`, '')
    }
    if (r.files && r.files.count) {
      out.push(`Attachments: ${r.files.count} file(s), ${r.files.bytes} bytes, ${r.files.checked ? 'read and checked against their rows' : 'to be copied'}.`, '')
    }
    if (r.skipped.length) {
      out.push('Not carried across, or changed on the way:')
      out.push(
        ...table(r.skipped, [
          { label: 'what', get: (x) => x.what },
          { label: 'count', get: (x) => x.count },
          { label: 'why', get: (x) => x.why },
        ]),
        '',
      )
    }
    if (r.rewrites && (r.rewrites.totals.rewritten || r.rewrites.totals.left || r.rewrites.totals.unknown)) {
      const w = r.rewrites
      out.push(
        w.applied
          ? 'Refs in prose (S-n and T-n become LAB-n and the new todo ref; --rewrite-refs is on):'
          : 'Refs in prose, left as written. With --rewrite-refs (S-n and T-n become LAB-n and the new todo ref):',
      )
      out.push(
        ...table(
          Object.entries(w.byTable).map(([name, t]) => ({ name, ...t })),
          [
            { label: 'table', get: (t) => t.name },
            { label: w.applied ? 'rewritten' : 'would rewrite', get: (t) => t.rewritten },
            { label: 'left in code or links', get: (t) => t.left },
            { label: 'no such subject/todo', get: (t) => t.unknown },
          ],
        ),
      )
      if (w.unknown.length) out.push(`  not in the mapping: ${w.unknown.slice(0, 20).join(', ')}${w.unknown.length > 20 ? ', …' : ''}`)
      if (w.sample.length) {
        out.push(`  ${w.sample.length} of ${w.totals.rewritten} rewrites, spread across the tables:`)
        for (const s of w.sample) {
          out.push(`    ${s.owner} ${s.field}: ${s.before}`, `    ${' '.repeat(String(s.owner).length + String(s.field).length + 2)}-> ${s.after}`)
        }
      }
      out.push('')
    }
  }
  if (r.notes.length) out.push('Notes:', ...r.notes.map((n) => `  - ${n}`), '')
  if (r.warnings.length) out.push('Warnings:', ...r.warnings.map((w) => `  - ${w}`), '')
  if (r.verification) {
    out.push(r.mode === 'apply' ? 'Checked before commit:' : 'Checked against the target (rolled back):')
    out.push(...r.verification.map((v) => `  ${v.ok ? 'ok  ' : 'FAIL'} ${v.name}: ${v.detail}`), '')
  }
  return out.join('\n')
}
