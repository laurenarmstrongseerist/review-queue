const SEARCH_API = 'https://api.github.com/search/issues'
const GRAPHQL_API = 'https://api.github.com/graphql'

export interface SearchPR {
  number: number
  title: string
  url: string
  createdAt: string
  isDraft: boolean
  author: string
  repo: string
}

export interface PRDetail {
  number: number
  headRefName: string
  baseRefName: string
  mergedAt: string | null
  mergeCommitOid: string | null
  mergeable: string | null
  ciState: string | null
  unresolvedThreads: number
  reviewDecision: string | null
  viewerReviewState: string | null
  timelineEvents: TimelineEvent[]
}

export interface RepoDeployment {
  environment: string
  state: string
  createdAt: string
  commitOid: string
  refName: string | null
}

interface TimelineEvent {
  type: 'ReadyForReviewEvent' | 'ConvertToDraftEvent'
  createdAt: string
}

interface GraphQLResponse {
  data?: Record<string, Record<string, RawPRDetail>>
  errors?: Array<{ message: string }>
}

interface RawPRDetail {
  number: number
  headRefName: string
  baseRefName: string
  mergedAt: string | null
  mergeCommit: { oid: string } | null
  mergeable: string | null
  ciStatus: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: string } | null
      }
    }>
  }
  reviewDecision: string | null
  latestOpinionatedReviews: {
    nodes: Array<{ author: { login: string }; state: string }>
  }
  reviewThreads: {
    nodes: Array<{ isResolved: boolean }>
  }
  timelineItems: {
    nodes: Array<{ __typename: string; createdAt: string }>
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function searchPRs(token: string, query: string): Promise<SearchPR[]> {
  const q = encodeURIComponent(query)
  const response = await fetch(
    `${SEARCH_API}?q=${q}&per_page=100&sort=created&order=desc`,
    { headers: headers(token) },
  )
  if (!response.ok) {
    throw new Error(`GitHub search failed: ${response.status} ${response.statusText}`)
  }
  const data = await response.json()

  return data.items.map((item: Record<string, unknown>) => {
    const repo = (item.repository_url as string).replace('https://api.github.com/repos/', '')
    const user = item.user as Record<string, unknown>
    return {
      number: item.number as number,
      title: item.title as string,
      url: item.html_url as string,
      createdAt: item.created_at as string,
      isDraft: (item.draft as boolean) ?? false,
      author: user.login as string,
      repo,
    }
  })
}

export function searchReviewRequested(token: string): Promise<SearchPR[]> {
  return searchPRs(token, 'is:pr is:open review-requested:@me')
}

export function searchAuthored(token: string): Promise<SearchPR[]> {
  return searchPRs(token, 'is:pr is:open author:@me')
}

export function searchMergedAuthored(token: string, sinceDate: string): Promise<SearchPR[]> {
  return searchPRs(token, `is:pr is:merged author:@me merged:>=${sinceDate}`)
}

function buildPRFragment(number: number): string {
  return `
    pr${number}: pullRequest(number: ${number}) {
      number
      headRefName
      baseRefName
      mergedAt
      mergeCommit { oid }
      mergeable
      reviewDecision
      ciStatus: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup { state }
          }
        }
      }
      latestOpinionatedReviews(first: 20) {
        nodes { author { login } state }
      }
      reviewThreads(first: 100) {
        nodes { isResolved }
      }
      timelineItems(first: 50, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]) {
        nodes {
          __typename
          ... on ReadyForReviewEvent { createdAt }
          ... on ConvertToDraftEvent { createdAt }
        }
      }
    }`
}

export async function fetchViewerLogin(token: string): Promise<string> {
  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ query: '{ viewer { login } }' }),
  })
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
  }
  const json = await response.json()
  return json.data.viewer.login
}

// Returns whether `head` includes `base` in its ancestry. Uses GitHub's compare endpoint:
// status "ahead" or "identical" → head contains base; "behind"/"diverged" → it does not.
export async function isAncestor(token: string, repo: string, base: string, head: string): Promise<boolean> {
  if (base === head) return true
  const [owner, name] = repo.split('/')
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${name}/compare/${base}...${head}`,
    { headers: headers(token) },
  )
  if (!response.ok) return false
  const data = await response.json()
  return data.status === 'ahead' || data.status === 'identical'
}

export async function fetchRepoDeployments(token: string, repo: string, sinceMs: number): Promise<RepoDeployment[]> {
  const [owner, name] = repo.split('/')
  const out: RepoDeployment[] = []
  let before: string | null = null
  // Safety cap: 10 pages × 100 = 1000 deploys per repo
  for (let i = 0; i < 10; i++) {
    const beforeArg = before ? `, before: "${before}"` : ''
    const query = `query {
      repository(owner: "${owner}", name: "${name}") {
        deployments(last: 100${beforeArg}) {
          pageInfo { startCursor hasPreviousPage }
          nodes { environment createdAt commitOid ref { name } latestStatus { state } }
        }
      }
    }`
    const response = await fetch(GRAPHQL_API, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ query }),
    })
    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
    }
    const json = await response.json()
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e: { message: string }) => e.message).join(', ')}`)
    }
    const deployments = json.data?.repository?.deployments
    const nodes: Array<{ environment: string | null; createdAt: string; commitOid: string; ref: { name: string } | null; latestStatus: { state: string } | null }> =
      deployments?.nodes ?? []
    for (const n of nodes) {
      if (!n.environment || !n.latestStatus) continue
      out.push({ environment: n.environment, state: n.latestStatus.state, createdAt: n.createdAt, commitOid: n.commitOid, refName: n.ref?.name ?? null })
    }
    const oldest = nodes.length > 0 ? new Date(nodes[0].createdAt).getTime() : Number.POSITIVE_INFINITY
    if (oldest < sinceMs || !deployments?.pageInfo?.hasPreviousPage) break
    before = deployments.pageInfo.startCursor
  }
  return out
}

export async function fetchPRDetails(
  token: string,
  repo: string,
  prNumbers: number[],
  viewerLogin?: string,
): Promise<PRDetail[]> {
  const [owner, name] = repo.split('/')
  const fragments = prNumbers.map(buildPRFragment).join('\n')
  const query = `query {
    repository(owner: "${owner}", name: "${name}") {
      ${fragments}
    }
  }`

  const response = await fetch(GRAPHQL_API, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ query }),
  })

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`)
  }

  const json: GraphQLResponse = await response.json()
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`)
  }

  const repoData = json.data!.repository
  return prNumbers.map((num) => {
    const pr = repoData[`pr${num}`]
    const commitNode = pr.ciStatus.nodes[0]
    const ciState = commitNode?.commit?.statusCheckRollup?.state ?? null
    const unresolvedThreads = pr.reviewThreads.nodes.filter((t) => !t.isResolved).length

    const timelineEvents: TimelineEvent[] = pr.timelineItems.nodes.map((n) => ({
      type: n.__typename as TimelineEvent['type'],
      createdAt: n.createdAt,
    }))

    const viewerReview = viewerLogin
      ? pr.latestOpinionatedReviews.nodes.find((r) => r.author.login === viewerLogin)
      : undefined
    const viewerReviewState = viewerReview?.state ?? null

    return { number: num, headRefName: pr.headRefName, baseRefName: pr.baseRefName, mergedAt: pr.mergedAt, mergeCommitOid: pr.mergeCommit?.oid ?? null, mergeable: pr.mergeable, ciState, unresolvedThreads, reviewDecision: pr.reviewDecision, viewerReviewState, timelineEvents }
  })
}
