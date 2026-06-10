import type { SearchPR, PRDetail } from './github.ts'

export type Bucket = 'ready' | 'blocked' | 'skipped' | 'failing' | 'building' | 'needsReview' | 'draft' | 'merged'

export interface ClassifiedPR {
  number: number
  title: string
  url: string
  author: string
  repo: string
  headRefName: string
  baseRefName: string
  daysOpen: string
  bucket: Bucket
  unresolvedThreads: number
  ciState: string | null
  hasConflicts: boolean
  deployedEnvs: string[]
  version: string | null
  ageMinutes: number
}

// ── Review queue classification (PRs requesting my review) ──

export interface ReviewResult {
  ready: ClassifiedPR[]
  blocked: ClassifiedPR[]
  skippedCount: number
}

export function classifyReviewPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): ReviewResult {
  const ready: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  let skippedCount = 0

  for (const pr of searchResults) {
    if (pr.isDraft) { skippedCount++; continue }

    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail) { skippedCount++; continue }
    if (detail.viewerReviewState === 'APPROVED') { skippedCount++; continue }
    if (detail.ciState !== 'SUCCESS') { skippedCount++; continue }

    const isBlocked = detail.unresolvedThreads > 0 || detail.mergeable === 'CONFLICTING'
    const classified = buildClassified(pr, detail, isBlocked ? 'blocked' : 'ready')

    if (classified.bucket === 'ready') ready.push(classified)
    else blocked.push(classified)
  }

  return { ready, blocked, skippedCount }
}

// ── My PRs classification ──

export interface MyPRsResult {
  readyToMerge: ClassifiedPR[]
  needsReview: ClassifiedPR[]
  blocked: ClassifiedPR[]
  building: ClassifiedPR[]
  failing: ClassifiedPR[]
  drafts: ClassifiedPR[]
  recentlyMerged: ClassifiedPR[]
}

export function classifyMyPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): MyPRsResult {
  const readyToMerge: ClassifiedPR[] = []
  const needsReview: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  const building: ClassifiedPR[] = []
  const failing: ClassifiedPR[] = []
  const drafts: ClassifiedPR[] = []

  for (const pr of searchResults) {
    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)

    if (pr.isDraft) {
      drafts.push(buildClassified(pr, detail ?? null, 'draft'))
      continue
    }

    if (!detail) continue

    if (detail.ciState === 'PENDING') {
      building.push(buildClassified(pr, detail, 'building'))
      continue
    }

    if (detail.ciState !== 'SUCCESS') {
      failing.push(buildClassified(pr, detail, 'failing'))
      continue
    }

    if (detail.unresolvedThreads > 0 || detail.mergeable === 'CONFLICTING') {
      blocked.push(buildClassified(pr, detail, 'blocked'))
      continue
    }

    if (detail.reviewDecision === 'APPROVED') {
      readyToMerge.push(buildClassified(pr, detail, 'ready'))
    } else {
      needsReview.push(buildClassified(pr, detail, 'needsReview'))
    }
  }

  return { readyToMerge, needsReview, blocked, building, failing, drafts, recentlyMerged: [] }
}

export interface PRMergedMetadata {
  envs: string[]
  version: string | null
}

export function classifyMergedPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
  cutoffMs: number,
  metadataByPR: Map<string, PRMergedMetadata>,
): ClassifiedPR[] {
  const merged: ClassifiedPR[] = []
  for (const pr of searchResults) {
    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail?.mergedAt) continue
    if (new Date(detail.mergedAt).getTime() < cutoffMs) continue

    const classified = buildClassified(pr, detail, 'merged')
    const elapsedMs = Date.now() - new Date(detail.mergedAt).getTime()
    classified.daysOpen = formatMergedAgo(detail.mergedAt)
    classified.ageMinutes = Math.floor(Math.max(0, elapsedMs) / 60_000)
    const meta = metadataByPR.get(`${pr.repo}#${pr.number}`)
    classified.deployedEnvs = meta?.envs ?? []
    classified.version = meta?.version ?? null
    merged.push(classified)
  }
  merged.sort((a, b) => {
    const detA = detailsByRepo.get(a.repo)?.find((d) => d.number === a.number)?.mergedAt ?? ''
    const detB = detailsByRepo.get(b.repo)?.find((d) => d.number === b.number)?.mergedAt ?? ''
    return detB.localeCompare(detA)
  })
  return merged
}

// Returns local-midnight timestamp at the start of the most recent weekday strictly before today.
// Mon → previous Fri. Tue–Fri → yesterday. Sat/Sun → previous Fri.
export function lastBusinessDayCutoff(now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  do {
    d.setDate(d.getDate() - 1)
  } while (d.getDay() === 0 || d.getDay() === 6)
  return d
}

export function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function formatMergedAgo(mergedAt: string): string {
  return formatElapsed(Date.now() - new Date(mergedAt).getTime())
}

// ── Dependabot classification ──

export interface DependabotResult {
  ready: ClassifiedPR[]
  blocked: ClassifiedPR[]
  building: ClassifiedPR[]
  failing: ClassifiedPR[]
}

export function classifyDependabotPRs(
  searchResults: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
): DependabotResult {
  const ready: ClassifiedPR[] = []
  const blocked: ClassifiedPR[] = []
  const building: ClassifiedPR[] = []
  const failing: ClassifiedPR[] = []

  for (const pr of searchResults) {
    if (pr.isDraft) continue

    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail) continue

    if (detail.ciState === 'PENDING') {
      building.push(buildClassified(pr, detail, 'building'))
      continue
    }

    if (detail.ciState !== 'SUCCESS') {
      failing.push(buildClassified(pr, detail, 'failing'))
      continue
    }

    if (detail.unresolvedThreads > 0 || detail.mergeable === 'CONFLICTING') {
      blocked.push(buildClassified(pr, detail, 'blocked'))
    } else {
      ready.push(buildClassified(pr, detail, 'ready'))
    }
  }

  return { ready, blocked, building, failing }
}

// ── Helpers ──

function buildClassified(pr: SearchPR, detail: PRDetail | null, bucket: Bucket): ClassifiedPR {
  const age = calcActiveAge(pr.createdAt, detail?.timelineEvents ?? [])
  return {
    number: pr.number,
    title: truncateTitle(pr.title),
    url: pr.url,
    author: pr.author,
    repo: pr.repo,
    headRefName: detail?.headRefName ?? '',
    baseRefName: detail?.baseRefName ?? '',
    daysOpen: age.display,
    ageMinutes: age.minutes,
    bucket,
    unresolvedThreads: detail?.unresolvedThreads ?? 0,
    ciState: detail?.ciState ?? null,
    hasConflicts: detail?.mergeable === 'CONFLICTING',
    deployedEnvs: [],
    version: null,
  }
}

function truncateTitle(title: string): string {
  return title.length > 60 ? title.slice(0, 57) + '...' : title
}

interface TimelineEvent {
  type: 'ReadyForReviewEvent' | 'ConvertToDraftEvent'
  createdAt: string
}

function calcActiveAge(createdAt: string, events: TimelineEvent[]): { display: string; minutes: number } {
  const created = new Date(createdAt).getTime()
  const now = Date.now()

  let draftMs = 0
  let draftStart: number | null = null

  if (events.length > 0 && events[0].type === 'ReadyForReviewEvent') {
    draftStart = created
  }

  for (const event of events) {
    const ts = new Date(event.createdAt).getTime()
    if (event.type === 'ConvertToDraftEvent') {
      draftStart = ts
    } else if (event.type === 'ReadyForReviewEvent' && draftStart !== null) {
      draftMs += ts - draftStart
      draftStart = null
    }
  }

  if (draftStart !== null) {
    draftMs += now - draftStart
  }

  const activeMs = Math.max(0, now - created - draftMs)
  return { display: formatElapsed(activeMs), minutes: Math.floor(activeMs / 60_000) }
}

function formatElapsed(elapsedMs: number): string {
  const mins = Math.floor(elapsedMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(elapsedMs / 3_600_000)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(elapsedMs / 86_400_000)
  return `${days}d`
}

export function groupByRepo(prs: ClassifiedPR[], order: 'asc' | 'desc' = 'desc'): Map<string, ClassifiedPR[]> {
  const groups = new Map<string, ClassifiedPR[]>()
  for (const pr of prs) {
    const list = groups.get(pr.repo) ?? []
    list.push(pr)
    groups.set(pr.repo, list)
  }
  const sorted = new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
  for (const [, list] of sorted) {
    list.sort((a, b) => order === 'asc' ? a.ageMinutes - b.ageMinutes : b.ageMinutes - a.ageMinutes)
  }
  return sorted
}

// ── Filters ──

export function isDependabot(pr: SearchPR): boolean {
  return pr.author === 'dependabot[bot]'
}
