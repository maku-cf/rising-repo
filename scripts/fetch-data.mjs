// 在 next build 之外抓資料寫入 db.json,再以 build-with-local-data 讀取。
// 目的:繞過 Next.js(app router)對全域 fetch 的 patch——該 patch 會讓 build 進程內
// 的 google-auth token 請求 ERR_STREAM_PREMATURE_CLOSE。獨立 node 進程用原生 fetch 不受影響。

import crypto from 'crypto'
import fs from 'fs'

const LIMIT = parseInt(process.env.RISING_LIMIT || '1000', 10)

// ---- 1) service account 換 access token(原生 fetch,不受 Next patch)----
const cred = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_KEY, 'base64').toString().replace(/\n/g, ''))
async function getToken() {
  const now = Math.floor(Date.now() / 1000)
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const AUD = 'https://oauth2.googleapis.com/token'
  const h = b({ alg: 'RS256', typ: 'JWT' })
  const c = b({ iss: cred.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: AUD, exp: now + 3600, iat: now })
  const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + c), cred.private_key).toString('base64url')
  const r = await fetch(AUD, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${h}.${c}.${sig}` })
  const j = await r.json()
  if (!j.access_token) throw new Error('token fail: ' + JSON.stringify(j))
  return j.access_token
}

// ---- 2) BigQuery:昨天+今天的 WatchEvent 上升榜(同原 getRankList SQL)----
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, '') }
function genSQL() {
  const today = new Date(), yest = new Date(Date.now() - 86400000)
  const days = [yest, today].map(ymd)
  const per = days.map(d => `SELECT repo.name AS repoName, COUNT(*) AS addedStarsTemp FROM \`githubarchive.day.${d}\` WHERE type='WatchEvent' GROUP BY repoName`)
  return `SELECT repoName, SUM(addedStarsTemp) AS addedStars FROM (${per.join(' UNION ALL ')}) GROUP BY repoName ORDER BY addedStars DESC LIMIT ${LIMIT}`
}
async function getRankList(token) {
  const proj = cred.project_id
  let r = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${proj}/queries`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: genSQL(), useLegacySql: false, timeoutMs: 60000 })
  })
  let j = await r.json()
  if (j.error) throw new Error('BQ error: ' + j.error.message)
  // poll 若未完成
  while (!j.jobComplete) {
    await new Promise(s => setTimeout(s, 2000))
    const jr = j.jobReference
    r = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${proj}/queries/${jr.jobId}?location=${jr.location || 'US'}`, { headers: { Authorization: `Bearer ${token}` } })
    j = await r.json()
  }
  return (j.rows || []).map(row => ({ repoName: row.f[0].v, addedStars: Number(row.f[1].v) }))
}

// ---- 3) GitHub 補全(同原 getARepo)----
async function getARepo(repoName) {
  try {
    const r = await fetch('https://api.github.com/repos/' + repoName, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${process.env.MY_GITHUB_TOKEN}`, 'User-Agent': 'rising-repo' }
    })
    if (!r.ok) return null
    const repo = await r.json()
    if (repo.language === 'Jupyter Notebook') repo.language = 'Jupyter'
    return repo
  } catch { return null }
}

// ---- main ----
const token = await getToken()
const rankList = await getRankList(token)
console.log(`BigQuery 回傳 ${rankList.length} 個 repo`)
const out = []
const batch = 80
for (let i = 0; i < rankList.length; i += batch) {
  const part = await Promise.all(rankList.slice(i, i + batch).map(async item => {
    const repo = await getARepo(item.repoName)
    if (!repo) return null
    return { repoName: item.repoName, addedStars: item.addedStars, language: repo.language, ownerAvatar: repo.owner.avatar_url, ownerLogin: repo.owner.login, description: repo.description, createdAt: repo.created_at, topics: repo.topics }
  }))
  out.push(...part.filter(Boolean))
  await new Promise(s => setTimeout(s, 100))
}
const path = process.env.DB_PATH || 'db.json'
fs.writeFileSync(path, JSON.stringify({ repoInfoList: out }))
console.log(`寫入 ${path}: ${out.length} 筆`)
