import { searchReviewRequested, searchAuthored, searchMergedAuthored, fetchPRDetails, fetchRepoDeployments, fetchViewerLogin, isAncestor } from './github.ts'
import type { SearchPR, RepoDeployment, PRDetail } from './github.ts'
import { classifyReviewPRs, classifyMyPRs, classifyDependabotPRs, classifyMergedPRs, isDependabot, lastBusinessDayCutoff, toIsoDate } from './classify.ts'
import type { ReviewResult, MyPRsResult, DependabotResult } from './classify.ts'
import { renderSection, renderSummary, renderError } from './render.ts'
import { getToken, saveToken, clearToken } from './token.ts'
import { themes, getTheme, saveTheme, applyTheme } from './themes.ts'
import type { ThemeConfig } from './themes.ts'
import './style.css'

const REFRESH_INTERVAL_MS = 3 * 60 * 1000
const $ = (id: string) => document.getElementById(id)!

let refreshTimer: ReturnType<typeof setInterval> | null = null
let hasLoadedOnce = false
let activeTheme: ThemeConfig = getTheme()
let activeTab: 'reviews' | 'myPRs' | 'dependabot' = 'reviews'

// Cached results for re-rendering on theme/tab switch
let cachedReviews: ReviewResult | null = null
let cachedMyPRs: MyPRsResult | null = null
let cachedDependabot: DependabotResult | null = null

function showTokenPrompt(): void {
  $('token-prompt').classList.remove('hidden')
  $('content').classList.add('hidden')
  $('loading').classList.add('hidden')
  $('error').classList.add('hidden')
}

function hideTokenPrompt(): void {
  $('token-prompt').classList.add('hidden')
}

// ── Tab switching ──

function switchTab(tab: typeof activeTab): void {
  activeTab = tab
  for (const t of ['reviews', 'myPRs', 'dependabot'] as const) {
    $(`tab-${t}`).classList.toggle('hidden', t !== tab)
  }
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === tab)
  })
  renderActiveTab()
}

function renderActiveTab(): void {
  if (!hasLoadedOnce) return
  const t = activeTheme

  if (activeTab === 'reviews' && cachedReviews) {
    const r = cachedReviews
    setText('reviews-ready-h', t.sections.ready)
    setText('reviews-blocked-h', t.sections.blocked)
    renderSection($('reviews-ready'), r.ready, t)
    renderSection($('reviews-blocked'), r.blocked, t, { showThreads: true })
    renderSummary($('reviews-summary'),
      `${r.ready.length} ready, ${r.blocked.length} blocked, ${r.skippedCount} skipped`)
  }

  if (activeTab === 'myPRs' && cachedMyPRs) {
    const m = cachedMyPRs
    setText('my-ready-h', t.sections.readyToMerge)
    setText('my-needsReview-h', t.sections.needsReview)
    setText('my-blocked-h', t.sections.myBlocked)
    setText('my-building-h', t.sections.building)
    setText('my-failing-h', t.sections.failingCI)
    setText('my-draft-h', t.sections.draft)
    setText('my-merged-h', t.sections.recentlyMerged)
    renderSection($('my-ready'), m.readyToMerge, t, { showAuthor: false })
    renderSection($('my-needsReview'), m.needsReview, t, { showAuthor: false })
    renderSection($('my-blocked'), m.blocked, t, { showThreads: true, showAuthor: false })
    renderSection($('my-building'), m.building, t, { showCI: true, showAuthor: false })
    renderSection($('my-failing'), m.failing, t, { showCI: true, showAuthor: false })
    renderSection($('my-draft'), m.drafts, t, { showAuthor: false })
    renderSection($('my-merged'), m.recentlyMerged, t, { showAuthor: false, showBaseBranch: true, showDeployedEnvs: true, showVersion: true, mergedColumn: true })
    const total = m.readyToMerge.length + m.needsReview.length + m.blocked.length + m.building.length + m.failing.length + m.drafts.length
    const mergedSuffix = m.recentlyMerged.length > 0 ? ` · ${m.recentlyMerged.length} recently merged` : ''
    renderSummary($('my-summary'),
      `${total} open — ${m.readyToMerge.length} ready to merge, ${m.needsReview.length} needs review, ${m.blocked.length} blocked, ${m.building.length} building, ${m.failing.length} failing, ${m.drafts.length} draft${mergedSuffix}`)
  }

  if (activeTab === 'dependabot' && cachedDependabot) {
    const d = cachedDependabot
    setText('dep-ready-h', t.sections.depReady)
    setText('dep-blocked-h', t.sections.depBlocked)
    setText('dep-building-h', t.sections.depBuilding)
    setText('dep-failing-h', t.sections.depFailing)
    renderSection($('dep-ready'), d.ready, t, { showAuthor: false })
    renderSection($('dep-blocked'), d.blocked, t, { showThreads: true, showAuthor: false })
    renderSection($('dep-building'), d.building, t, { showCI: true, showAuthor: false })
    renderSection($('dep-failing'), d.failing, t, { showCI: true, showAuthor: false })
    const total = d.ready.length + d.blocked.length + d.building.length + d.failing.length
    renderSummary($('dep-summary'),
      `${total} open — ${d.ready.length} ready, ${d.blocked.length} blocked, ${d.building.length} building, ${d.failing.length} failing`)
  }
}

function setText(id: string, text: string): void {
  $(id).textContent = text
}

// ── Data fetching ──

async function fetchDetails(token: string, prs: SearchPR[], viewerLogin: string): Promise<Map<string, import('./github.ts').PRDetail[]>> {
  const byRepo = new Map<string, number[]>()
  for (const pr of prs) {
    const list = byRepo.get(pr.repo) ?? []
    list.push(pr.number)
    byRepo.set(pr.repo, list)
  }

  const entries = await Promise.all(
    [...byRepo.entries()].map(async ([repo, numbers]) => {
      const details = await fetchPRDetails(token, repo, numbers, viewerLogin)
      return [repo, details] as const
    }),
  )
  return new Map(entries)
}

// Successful states include INACTIVE — a previously-successful deploy that was superseded.
const SUCCESS_STATES = new Set(['SUCCESS', 'ACTIVE', 'INACTIVE'])

// For each merged PR derive: (a) which envs it landed in — env attributed only when its tip
// commit contains the PR merge (ancestry, not timestamp, to avoid rollback false-positives);
// (b) the first version that shipped it — earliest post-merge deploy whose commit contains it.
async function computePRMetadata(
  token: string,
  mergedPRs: SearchPR[],
  detailsByRepo: Map<string, PRDetail[]>,
  deploymentsByRepo: Map<string, RepoDeployment[]>,
): Promise<Map<string, { envs: string[]; version: string | null }>> {
  const cache = new Map<string, Promise<boolean>>()
  const check = (repo: string, base: string, head: string): Promise<boolean> => {
    const key = `${repo}|${base}|${head}`
    let p = cache.get(key)
    if (!p) {
      p = isAncestor(token, repo, base, head).catch(() => false)
      cache.set(key, p)
    }
    return p
  }

  const envTipsByRepo = new Map<string, Array<{ env: string; sha: string; createdAt: string }>>()
  const deploysAscByRepo = new Map<string, RepoDeployment[]>()
  for (const [repo, deploys] of deploymentsByRepo) {
    const latestByEnv = new Map<string, { sha: string; createdAt: string }>()
    for (const d of deploys) {
      if (!SUCCESS_STATES.has(d.state)) continue
      const cur = latestByEnv.get(d.environment)
      if (!cur || d.createdAt > cur.createdAt) {
        latestByEnv.set(d.environment, { sha: d.commitOid, createdAt: d.createdAt })
      }
    }
    envTipsByRepo.set(repo, [...latestByEnv.entries()].map(([env, v]) => ({ env, ...v })))
    deploysAscByRepo.set(repo, [...deploys].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
  }

  const result = new Map<string, { envs: string[]; version: string | null }>()
  await Promise.all(mergedPRs.map(async (pr) => {
    const detail = detailsByRepo.get(pr.repo)?.find((d) => d.number === pr.number)
    if (!detail?.mergeCommitOid || !detail.mergedAt) return
    const mergeMs = new Date(detail.mergedAt).getTime()

    const tips = envTipsByRepo.get(pr.repo) ?? []
    const envChecks = await Promise.all(
      tips.map(async (tip) => (await check(pr.repo, detail.mergeCommitOid!, tip.sha)) ? tip : null),
    )
    const envs = envChecks
      .filter((x): x is { env: string; sha: string; createdAt: string } => x !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((h) => h.env)

    let version: string | null = null
    const seenShas = new Set<string>()
    for (const d of deploysAscByRepo.get(pr.repo) ?? []) {
      if (!d.refName) continue
      if (new Date(d.createdAt).getTime() < mergeMs) continue
      if (seenShas.has(d.commitOid)) continue
      seenShas.add(d.commitOid)
      if (await check(pr.repo, detail.mergeCommitOid, d.commitOid)) {
        version = d.refName
        break
      }
    }

    result.set(`${pr.repo}#${pr.number}`, { envs, version })
  }))
  return result
}

async function loadQueue(token: string): Promise<void> {
  $('error').classList.add('hidden')

  if (hasLoadedOnce) {
    $('progress-bar').classList.add('active')
  } else {
    $('loading').classList.remove('hidden')
    $('content').classList.add('hidden')
  }

  try {
    const cutoff = lastBusinessDayCutoff()
    // Shift search date back one day: GitHub interprets `merged:>=YYYY-MM-DD` in UTC,
    // so a local-midnight cutoff may exclude PRs the client-side filter would keep.
    const searchSince = toIsoDate(new Date(cutoff.getTime() - 86_400_000))
    const [reviewPRs, authoredPRs, mergedPRs, viewerLogin] = await Promise.all([
      searchReviewRequested(token),
      searchAuthored(token),
      searchMergedAuthored(token, searchSince),
      fetchViewerLogin(token),
    ])

    // Split review PRs into human and dependabot
    const humanReviewPRs = reviewPRs.filter((pr) => !isDependabot(pr))
    const dependabotPRs = reviewPRs.filter(isDependabot)

    // Collect all unique PRs for GraphQL batching
    const allPRs = [...reviewPRs, ...authoredPRs, ...mergedPRs]
    const detailsByRepo = await fetchDetails(token, allPRs, viewerLogin)

    const mergedRepos = [...new Set(mergedPRs.map((p) => p.repo))]
    const deploymentsByRepo = new Map<string, RepoDeployment[]>(
      await Promise.all(
        mergedRepos.map(async (repo) => {
          try { return [repo, await fetchRepoDeployments(token, repo, cutoff.getTime())] as const }
          catch (err) {
            console.warn(`Failed to fetch deployments for ${repo}:`, err)
            return [repo, [] as RepoDeployment[]] as const
          }
        }),
      ),
    )
    const metadataByPR = await computePRMetadata(token, mergedPRs, detailsByRepo, deploymentsByRepo)

    cachedReviews = classifyReviewPRs(humanReviewPRs, detailsByRepo)
    cachedMyPRs = classifyMyPRs(authoredPRs, detailsByRepo)
    cachedMyPRs.recentlyMerged = classifyMergedPRs(mergedPRs, detailsByRepo, cutoff.getTime(), metadataByPR)
    cachedDependabot = classifyDependabotPRs(dependabotPRs, detailsByRepo)

    $('loading').classList.add('hidden')
    $('progress-bar').classList.remove('active')
    $('content').classList.remove('hidden')
    hasLoadedOnce = true

    renderActiveTab()
    updateTimestamp()
    updateBadge(cachedReviews.ready.length)
  } catch (err) {
    $('loading').classList.add('hidden')
    $('progress-bar').classList.remove('active')
    const message = err instanceof Error ? err.message : 'Unknown error'

    if (message.includes('401')) {
      clearToken()
      renderError($('error'), 'Token expired or invalid. Please re-enter.')
      showTokenPrompt()
      return
    }

    renderError($('error'), `Failed to load PRs: ${message}`, [
      { label: 'Re-enter token', onClick: () => { clearToken(); showTokenPrompt() } },
    ])
  }
}

function updateTimestamp(): void {
  const now = new Date()
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  $('last-updated').textContent = `Updated ${time}`
}

function updateBadge(count: number): void {
  if ('setAppBadge' in navigator) {
    if (count > 0) navigator.setAppBadge(count)
    else navigator.clearAppBadge()
  }
}

function startAutoRefresh(token: string): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => loadQueue(token), REFRESH_INTERVAL_MS)
}

// ── UI init ──

function initTabs(): void {
  const bar = $('tab-bar')
  for (const [key, label] of [
    ['reviews', activeTheme.tabs.reviews],
    ['myPRs', activeTheme.tabs.myPRs],
    ['dependabot', activeTheme.tabs.dependabot],
  ] as const) {
    const btn = document.createElement('button')
    btn.className = `tab-btn ${key === activeTab ? 'active' : ''}`
    btn.dataset.tab = key
    btn.textContent = label
    btn.addEventListener('click', () => switchTab(key as typeof activeTab))
    bar.appendChild(btn)
  }
}

function updateTabLabels(): void {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const tab = (btn as HTMLElement).dataset.tab as keyof typeof activeTheme.tabs
    if (tab && activeTheme.tabs[tab]) btn.textContent = activeTheme.tabs[tab]
  })
}

function initThemePicker(): void {
  const picker = $('theme-picker')
  for (const theme of Object.values(themes)) {
    const btn = document.createElement('button')
    btn.className = `theme-btn ${theme.id === activeTheme.id ? 'active' : ''}`
    btn.dataset.theme = theme.id
    btn.textContent = theme.label
    btn.addEventListener('click', () => {
      activeTheme = themes[theme.id]
      saveTheme(theme.id)
      document.querySelectorAll('.theme-btn').forEach((b) => {
        b.classList.toggle('active', (b as HTMLElement).dataset.theme === theme.id)
      })
      updateTabLabels()
      renderActiveTab()
    })
    picker.appendChild(btn)
  }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(activeTheme.id)
  initTabs()
  initThemePicker()

  const tokenForm = $('token-form') as HTMLFormElement
  const tokenInput = $('token-input') as HTMLInputElement
  const refreshBtn = $('refresh-btn')
  const createTokenLink = $('create-token-link') as HTMLAnchorElement
  const tokenInfoBtn = $('token-info-btn')
  const tokenInfo = $('token-info')

  createTokenLink.href = 'https://github.com/settings/tokens/new?scopes=repo&description=Review+Queue'
  tokenInfoBtn.addEventListener('click', () => tokenInfo.classList.toggle('hidden'))

  tokenForm.addEventListener('submit', (e) => {
    e.preventDefault()
    const token = tokenInput.value.trim()
    if (!token) return
    saveToken(token)
    tokenInput.value = ''
    hideTokenPrompt()
    loadQueue(token)
    startAutoRefresh(token)
  })

  refreshBtn.addEventListener('click', () => {
    const token = getToken()
    if (token) loadQueue(token)
  })

  const token = getToken()
  if (token) {
    hideTokenPrompt()
    loadQueue(token)
    startAutoRefresh(token)
  } else {
    showTokenPrompt()
  }
})

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('sw.js', import.meta.url).href).catch(() => {})
}
