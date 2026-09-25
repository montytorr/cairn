import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * The content hash of the CLI this deployment was built from.
 *
 * WHY THE VERSION WAS NOT ENOUGH. CAIRN-246 put the release version on every
 * response so a stale CLI could notice without being asked, and it works
 * exactly as designed — which turned out to be almost never. Releases are
 * cut by hand and 133 commits fitted inside v0.5.1, so nearly all real drift
 * is INTRA-version: both sides said 0.5.1 while the Mac's copy was missing
 * `--allow-dangling` on relearn and the whole vitals memory block, and no
 * warning was possible. A version says which release a copy belongs to; it
 * cannot say whether it is that release's current file (CAIRN-261).
 *
 * A CONTENT HASH CAN, and it is the one identifier a copied file can compute
 * about itself. A CLI does not know which commit it came from — it is a
 * single file copied into ~/.local/bin, with no repository behind it — but it
 * can always read itself. That constraint is what made the version constant
 * the easy choice in the first place, and hashing is what removes it.
 *
 * Same digest as scripts/sync-agent-files.mjs: sha256, first 16 hex. The two
 * mechanisms then speak one language — the installer's log line and this
 * header print the same string for the same file, which is what makes "the
 * server says 05b4c2f4, my copy is e592a2f4" an answer rather than a puzzle.
 */
const SHORT = 16

const digest = (buffer: Buffer | string) =>
  createHash('sha256').update(buffer).digest('hex').slice(0, SHORT)

/**
 * Read once, at module load, and never again: in the container the source
 * cannot change while the process lives, and this sits on the path every
 * response takes.
 *
 * Two sources, in order. `public/cli-hash.txt` is written by the Dockerfile
 * from the repository it built, the same way `public/build-version.txt`
 * records the commit — the standalone Next build does not trace `cli/` and
 * would not carry the file itself. Falling back to hashing the file in place
 * is what makes `npm run dev` and the test suite report a real fingerprint
 * rather than a special case.
 *
 * Null when neither is available, and null means the header is simply absent.
 * A CLI that hears nothing must go on working — the check is an improvement
 * on silence, never a dependency.
 */
export const CLI_FINGERPRINT: string | null = (() => {
  try {
    const recorded = readFileSync('public/cli-hash.txt', 'utf8').trim()
    if (/^[0-9a-f]{16}$/.test(recorded)) return recorded
  } catch {
    // Not built by the Dockerfile. Fall through and hash the source.
  }
  try {
    return digest(readFileSync('cli/cairn.mjs'))
  } catch {
    return null
  }
})()

export const CLI_HEADER = 'x-cairn-cli'

/**
 * When this image was built, so a CLI that disagrees with the fingerprint can
 * tell which side is newer (CAIRN-290).
 *
 * A hash says two files differ and nothing about their order, and a copied
 * CLI has no commit to compare. It does have an mtime — the moment the sync
 * wrote it — so an image built after that is the newer side, and a CLI
 * written after the image was built is almost always a merge that has not
 * deployed yet. Written by the Dockerfile; absent outside an image, and an
 * absent header leaves the client phrasing the drift neutrally.
 */
export const BUILT_AT: string | null = (() => {
  try {
    const recorded = readFileSync('public/build-time.txt', 'utf8').trim()
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(recorded) ? recorded : null
  } catch {
    return null
  }
})()

export const BUILT_AT_HEADER = 'x-cairn-built-at'

/** Exported for the Dockerfile's generator and for the test that pins them together. */
export const fingerprintOf = (contents: Buffer | string) => digest(contents)
