#!/usr/bin/env node
/**
 * 个人主页资产生成器。
 *
 * 设计取舍：
 *   - 公共卡片服务（github-readme-stats / trophy / activity-graph）已长期不可用，
 *     因此所有数据卡都在本仓库内自产，README 只引用自己的产物，杜绝破图。
 *   - README 里不写死任何项目：卡片、账本、动态区块全部由仓库现状推导。
 *     手写的项目清单会腐烂 —— 换方向时没人回来改 README，主页就开始说谎。
 *   - 一次 GraphQL 请求取全部事实（用户 + 自有公开仓库 + release 历史 + 贡献日历），
 *     避免上百次 REST 往返，同时把速率消耗压到 1 次。
 *   - 暗/亮两套调色板由同一份绘制代码产出，README 侧用 <picture> 切换，
 *     保证两种主题下都不会出现“白底白字”。
 *   - 抓取失败时直接非零退出、不写任何文件：宁可保留上一次成功的卡，
 *     也不能把空卡提交进 README。
 *
 * 用法：GITHUB_TOKEN=... node scripts/build-profile.mjs
 */

import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const LOGIN = process.env.PROFILE_LOGIN ?? "Lynricsy";
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN（本地可用：export GITHUB_TOKEN=$(gh auth token)）");
  process.exit(1);
}

/* ---------------------------------------------------------------- 数据抓取 */

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    name
    login
    createdAt
    followers { totalCount }
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { firstDay contributionDays { date contributionCount } }
      }
    }
    repositories(
      first: 100
      ownerAffiliations: OWNER
      isFork: false
      privacy: PUBLIC
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      totalCount
      nodes {
        name
        description
        url
        stargazerCount
        forkCount
        pushedAt
        createdAt
        isArchived
        primaryLanguage { name color }
        releases(first: 25, orderBy: { field: CREATED_AT, direction: DESC }) {
          totalCount
          nodes {
            tagName
            publishedAt
            url
            releaseAssets(first: 1) { totalCount }
          }
        }
      }
    }
  }
}`;

// 旗舰仓库最新一次构建的资产明细单独取：100 仓库 × 25 release × 100 资产
// 会直接撞上 GraphQL 的 RESOURCE_LIMITS_EXCEEDED，所以主查询只要 totalCount。
const FLAGSHIP_QUERY = `
query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    releases(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        tagName
        publishedAt
        url
        releaseAssets(first: 100) { totalCount nodes { size downloadCount } }
      }
    }
  }
}`;

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": `${LOGIN}-profile-builder`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(body.errors).slice(0, 300)}`);
  if (!body.data) throw new Error("GraphQL 返回空 data");
  return body.data;
}

async function fetchFacts() {
  const { user } = await graphql(QUERY, { login: LOGIN });
  if (!user) throw new Error("GraphQL 返回空 user");
  return user;
}

/** 取旗舰仓库最新构建的资产明细（体积、下载数）。 */
async function fetchFlagshipBuild(repoName) {
  const { repository } = await graphql(FLAGSHIP_QUERY, { owner: LOGIN, name: repoName });
  const rel = repository?.releases?.nodes?.[0];
  if (!rel) throw new Error(`旗舰仓库 ${repoName} 没有可读的 release`);
  return rel;
}

/* ---------------------------------------------------------------- 事实整理 */

function digest(user) {
  const repos = user.repositories.nodes.filter(Boolean);
  // 主页仓库自己不算“最近推进”：刷新卡片的机器人提交会把它永远顶在第一行。
  const active = repos.filter((r) => !r.isArchived && r.name.toLowerCase() !== user.login.toLowerCase());
  const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const forks = repos.reduce((s, r) => s + r.forkCount, 0);

  // 语言分布按“仓库主语言计数”统计。刻意不用代码字节数：
  // 字节数会被生成物和大文件放大，跟熟练度没有关系。
  const langCount = new Map();
  for (const r of repos) {
    const lang = r.primaryLanguage;
    if (!lang) continue;
    const cur = langCount.get(lang.name) ?? { name: lang.name, color: lang.color, count: 0 };
    cur.count += 1;
    langCount.set(lang.name, cur);
  }
  const langs = [...langCount.values()].sort((a, b) => b.count - a.count);

  // 全部 release 摊平成一条时间线，供“发布节奏”和“最近发布”共用。
  const timeline = [];
  for (const r of repos) {
    for (const rel of r.releases.nodes) {
      if (rel?.publishedAt) timeline.push({ repo: r, release: rel });
    }
  }
  timeline.sort((a, b) => Date.parse(b.release.publishedAt) - Date.parse(a.release.publishedAt));

  // 每仓库只保留最新一条，用于“最近发布”列表。
  const latestPerRepo = [];
  const seen = new Set();
  for (const item of timeline) {
    if (seen.has(item.repo.name)) continue;
    seen.add(item.repo.name);
    latestPerRepo.push(item);
  }

  // 旗舰项目 = star 最高且发过 release 的仓库；随仓库现状自动更换，不写死名字。
  const flagship = repos
    .filter((r) => r.releases.nodes.some((n) => n?.publishedAt))
    .sort((a, b) => b.stargazerCount - a.stargazerCount)[0];

  const calendar = user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks.flatMap((w) => w.contributionDays);
  const weeks = calendar.weeks.map((w) => ({
    firstDay: w.firstDay,
    total: w.contributionDays.reduce((s, x) => s + x.contributionCount, 0),
  }));
  let run = 0;
  let bestStreak = 0;
  for (const dd of days) {
    run = dd.contributionCount > 0 ? run + 1 : 0;
    if (run > bestStreak) bestStreak = run;
  }

  return {
    login: user.login,
    since: user.createdAt.slice(0, 7),
    followers: user.followers.totalCount,
    contributionsYear: calendar.totalContributions,
    activeDays: days.filter((x) => x.contributionCount > 0).length,
    bestDay: days.reduce((m, x) => Math.max(m, x.contributionCount), 0),
    bestStreak,
    weeks,
    repoCount: user.repositories.totalCount,
    stars,
    forks,
    langs,
    timeline,
    latestPerRepo,
    flagship,
    repos,
    recent: active.slice(0, 6),
    topRepos: [...repos].sort((a, b) => b.stargazerCount - a.stargazerCount),
  };
}

/* ---------------------------------------------------------------- 绘制工具 */

// 调色板与 assets/hero-*.svg 对齐（琥珀 → 玫瑰 → 紫），
// 否则页头和数据卡会看起来像两个不同的人做的。
const THEMES = {
  dark: {
    id: "dark",
    bg0: "#0a0d13",
    bg1: "#17132e",
    stroke: "#2b2545",
    grid: "#242040",
    text: "#eef1f7",
    dim: "#a8b3c4",
    faint: "#7d8899",
    accent: "#ffc857",
    accent2: "#e5657f",
    good: "#7fd6a3",
    // 柱状渐变的底部不透明度：亮底需要更实，否则细柱在米色上几乎消失。
    fadeLow: ".38",
  },
  light: {
    id: "light",
    bg0: "#fdfbf6",
    bg1: "#efe8ef",
    stroke: "#ded3d0",
    grid: "#e7dcdb",
    text: "#201a22",
    dim: "#5c5158",
    faint: "#8d8189",
    accent: "#c9821a",
    accent2: "#b34a63",
    good: "#157f52",
    fadeLow: ".62",
  },
};

const MONO = "'JetBrains Mono','Fira Code','SFMono-Regular',ui-monospace,Menlo,Consolas,monospace";
const SANS = "'Noto Sans SC','PingFang SC','Microsoft YaHei','Segoe UI',Helvetica,Arial,sans-serif";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const day = (iso) => iso.slice(0, 10);
const nf = (n) => n.toLocaleString("en-US");
/** 按码点截断，避免把中文或 emoji 切成半个字符。 */
const clip = (s, n) => {
  const cp = [...String(s ?? "")];
  return cp.length > n ? `${cp.slice(0, n - 1).join("")}…` : cp.join("");
};

/** 生成一条平滑的正弦折线，用作“信号”底纹。 */
function wave({ x, y, width, amp, periods, points = 96, phase = 0 }) {
  const step = width / (points - 1);
  const out = [];
  for (let i = 0; i < points; i += 1) {
    const t = i / (points - 1);
    const py = y + Math.sin(t * Math.PI * 2 * periods + phase) * amp * (0.45 + 0.55 * Math.sin(t * Math.PI));
    out.push(`${(x + i * step).toFixed(1)},${py.toFixed(1)}`);
  }
  return out.join(" ");
}

/** 卡片外框 + 共用渐变/动画。所有动画都是纯 CSS，<img> 上下文里没有 JS。 */
function shell({ t, w, h, title, subtitle, body, extraStyle = "" }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg0}"/>
      <stop offset="1" stop-color="${t.bg1}"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${t.accent}"/>
      <stop offset="1" stop-color="${t.accent2}"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${t.accent}" stop-opacity="${t.fadeLow}"/>
      <stop offset="1" stop-color="${t.accent2}" stop-opacity=".95"/>
    </linearGradient>
  </defs>
  <style>
    text { font-family: ${SANS}; }
    .mono { font-family: ${MONO}; }
    .t { fill: ${t.text}; }
    .d { fill: ${t.dim}; }
    .f { fill: ${t.faint}; }
    .title { font-size: 13px; font-weight: 600; letter-spacing: .06em; }
    .kpi { font-size: 22px; font-weight: 700; }
    .cap { font-size: 9.5px; letter-spacing: .12em; }
    .sm { font-size: 10.5px; }
    @keyframes drift { from { transform: translateX(0); } to { transform: translateX(-160px); } }
    @keyframes glow { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
    @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @keyframes rise { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    @keyframes pop { from { opacity: 0; transform: scale(.2); } to { opacity: 1; transform: scale(1); } }
    .drift { animation: drift 14s linear infinite; }
    .glow { animation: glow 4.5s ease-in-out infinite; }
    .grow { transform-box: fill-box; transform-origin: left center; animation: grow 1.6s cubic-bezier(.22,1,.36,1) both; }
    .rise { transform-box: fill-box; transform-origin: bottom center; animation: rise 1.1s cubic-bezier(.22,1,.36,1) both; }
    .pop { transform-box: fill-box; transform-origin: center; animation: pop .7s cubic-bezier(.22,1,.36,1) both; }
    @media (prefers-reduced-motion: reduce) {
      .drift, .glow, .grow, .rise, .pop { animation: none; }
      .grow, .rise, .pop { transform: none; opacity: 1; }
    }
${extraStyle}
  </style>
  <rect width="${w}" height="${h}" rx="14" fill="url(#bg)"/>
  <rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="13.5" fill="none" stroke="${t.stroke}"/>
  <rect x="14" y="14" width="3" height="14" rx="1.5" fill="url(#edge)"/>
  <text class="t title" x="26" y="25">${esc(title)}</text>
  <text class="f cap mono" x="${w - 16}" y="25" text-anchor="end">${esc(subtitle)}</text>
${body}
</svg>
`;
}

/** 一行 KPI 数字 + 小标签。 */
function kpiRow(pairs, { x = 26, y = 72, pitch = 100 } = {}) {
  return pairs
    .map(([cap, val], i) => {
      const px = x + i * pitch;
      return `  <text class="t kpi mono" x="${px}" y="${y}">${esc(val)}</text>
  <text class="f cap mono" x="${px}" y="${y + 15}">${esc(cap.toUpperCase())}</text>`;
    })
    .join("\n");
}

/* ------------------------------------------------------------ 卡片：信号台 */

function signalCard(t, d, stamp) {
  const w = 430;
  const h = 250;
  const kpis = kpiRow([
    ["repos", nf(d.repoCount)],
    ["stars", nf(d.stars)],
    ["forks", nf(d.forks)],
    ["followers", nf(d.followers)],
  ]);

  // 语言光谱：前 6 名 + 其余归并，宽度按仓库数占比。
  const total = d.langs.reduce((s, l) => s + l.count, 0) || 1;
  const top = d.langs.slice(0, 6);
  const restCount = total - top.reduce((s, l) => s + l.count, 0);
  const bars = [...top, ...(restCount > 0 ? [{ name: "other", color: t.faint, count: restCount }] : [])];
  const barW = w - 52;
  let cursor = 26;
  const spectrum = bars
    .map((l, i) => {
      const width = Math.max(3, (l.count / total) * barW);
      const seg = `  <rect class="grow" x="${cursor.toFixed(1)}" y="118" width="${width.toFixed(1)}" height="10" rx="3" fill="${l.color ?? t.faint}" style="animation-delay:${i * 90}ms"/>`;
      cursor += width;
      return seg;
    })
    .join("\n");

  const legend = bars
    .slice(0, 6)
    .map((l, i) => {
      const x = 26 + (i % 3) * 135;
      const y = 152 + Math.floor(i / 3) * 19;
      return `  <circle cx="${x + 4}" cy="${y - 3.5}" r="4" fill="${l.color ?? t.faint}"/>
  <text class="d sm mono" x="${x + 14}" y="${y}">${esc(l.name)} · ${l.count}</text>`;
    })
    .join("\n");

  const body = `${kpis}
  <text class="f cap mono" x="26" y="108">PRIMARY LANGUAGE PER OWN REPO</text>
${spectrum}
${legend}
  <g opacity=".5">
    <polyline class="drift" points="${wave({ x: -160, y: 218, width: w + 340, amp: 9, periods: 5.5 })}" fill="none" stroke="url(#edge)" stroke-width="1.6"/>
  </g>
  <text class="f cap mono" x="26" y="238">SINCE ${esc(d.since)}</text>
  <text class="f cap mono" x="${w - 16}" y="238" text-anchor="end">${esc(stamp)}</text>`;

  return { file: `signal-${t.id}.svg`, svg: shell({ t, w, h, title: "signal board", subtitle: `@${d.login}`, body }) };
}

/* ---------------------------------------------------------- 卡片：贡献节律 */

function rhythmCard(t, d) {
  const w = 430;
  const h = 250;
  const weeks = d.weeks;
  const peak = Math.max(1, ...weeks.map((x) => x.total));
  const left = 26;
  const right = w - 26;
  const base = 194;
  const maxBar = 74;
  const pitch = (right - left) / weeks.length;
  const barW = Math.max(2.2, pitch - 1.6);

  const bars = weeks
    .map((wk, i) => {
      const hgt = Math.max(1.5, (wk.total / peak) * maxBar);
      const x = left + i * pitch;
      return `  <rect class="rise" x="${x.toFixed(1)}" y="${(base - hgt).toFixed(1)}" width="${barW.toFixed(1)}" height="${hgt.toFixed(1)}" rx="1.2" fill="url(#fade)" style="animation-delay:${i * 14}ms"/>`;
    })
    .join("\n");

  // 每 13 周标一次年月；靠右塞不下整个标签的就不画，避免出框。
  const ticks = weeks
    .map((wk, i) => (i % 13 === 0 ? { i, label: wk.firstDay.slice(0, 7) } : null))
    .filter((x) => x && left + x.i * pitch < right - 46)
    .map(({ i, label }) => `  <text class="f cap mono" x="${(left + i * pitch).toFixed(1)}" y="211">${esc(label)}</text>`)
    .join("\n");

  const avg = (d.contributionsYear / (weeks.length || 1)).toFixed(0);
  const kpis = kpiRow([
    ["contributions", nf(d.contributionsYear)],
    ["active days", nf(d.activeDays)],
    ["peak day", nf(d.bestDay)],
    ["best run", `${nf(d.bestStreak)}d`],
  ]);

  const body = `${kpis}
  <text class="f cap mono" x="26" y="108">WEEKLY VOLUME · TRAILING ${weeks.length} WEEKS</text>
${bars}
  <line x1="${left}" y1="${base + 1}" x2="${right}" y2="${base + 1}" stroke="${t.grid}" stroke-width="1"/>
${ticks}
  <text class="f cap mono" x="26" y="238">AVG ${esc(avg)} / WEEK · PEAK ${nf(peak)} IN ONE WEEK</text>`;

  return { file: `rhythm-${t.id}.svg`, svg: shell({ t, w, h, title: "contribution rhythm", subtitle: `${weeks.length}w`, body }) };
}

/* ---------------------------------------------------------- 卡片：发布节奏 */

function cadenceCard(t, d) {
  const w = 430;
  const h = 250;
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i -= 1) {
    const dt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ key: dt.toISOString().slice(0, 7), count: 0, repos: new Set() });
  }
  const index = new Map(months.map((m) => [m.key, m]));
  for (const { repo, release } of d.timeline) {
    const m = index.get(release.publishedAt.slice(0, 7));
    if (!m) continue;
    m.count += 1;
    m.repos.add(repo.name);
  }

  const peak = Math.max(1, ...months.map((m) => m.count));
  const left = 32;
  const right = w - 26;
  const base = 194;
  const maxBar = 68;
  const pitch = (right - left) / months.length;
  const barW = pitch - 8;

  const bars = months
    .map((m, i) => {
      // 平方根刻度：旗舰仓库每日快照会把某个月推到 60+，线性刻度下其余月份全成一条线。
      const hgt = m.count === 0 ? 2 : Math.max(6, Math.sqrt(m.count / peak) * maxBar);
      const x = left + i * pitch;
      const fill = m.count === 0 ? t.grid : "url(#fade)";
      const label =
        m.count > 0
          ? `\n  <text class="f cap mono" x="${(x + barW / 2).toFixed(1)}" y="${(base - hgt - 5).toFixed(1)}" text-anchor="middle">${m.count}</text>`
          : "";
      return `  <rect class="rise" x="${x.toFixed(1)}" y="${(base - hgt).toFixed(1)}" width="${barW.toFixed(1)}" height="${hgt.toFixed(1)}" rx="2" fill="${fill}" style="animation-delay:${i * 55}ms"/>${label}`;
    })
    .join("\n");

  const ticks = months
    .map((m, i) => {
      const x = left + i * pitch + barW / 2;
      return `  <text class="f cap mono" x="${x.toFixed(1)}" y="211" text-anchor="middle">${esc(m.key.slice(5))}</text>`;
    })
    .join("\n");

  const shipped = months.reduce((s, m) => s + m.count, 0);
  const shippingRepos = new Set(months.flatMap((m) => [...m.repos])).size;
  const kpis = kpiRow(
    [
      ["releases 12m", nf(shipped)],
      ["repos shipping", nf(shippingRepos)],
      ["busiest month", nf(peak)],
    ],
    { pitch: 132 },
  );

  const body = `${kpis}
  <text class="f cap mono" x="26" y="108">TAGGED RELEASES PER MONTH</text>
${bars}
  <line x1="${left}" y1="${base + 1}" x2="${right}" y2="${base + 1}" stroke="${t.grid}" stroke-width="1"/>
${ticks}
  <text class="f cap mono" x="26" y="238">${nf(d.timeline.length)} RELEASES ON RECORD ACROSS ALL REPOS</text>`;

  return { file: `cadence-${t.id}.svg`, svg: shell({ t, w, h, title: "shipping cadence", subtitle: "12m", body }) };
}

/* -------------------------------------------------------- 卡片：仓库星图 */

function constellationCard(t, d) {
  const w = 880;
  const h = 300;
  const plotted = d.repos.filter((r) => r.pushedAt);
  const times = plotted.map((r) => Date.parse(r.pushedAt));
  const tMin = Math.min(...times);
  const tMax = Math.max(Date.now(), ...times);
  const maxStars = Math.max(1, ...plotted.map((r) => r.stargazerCount));

  const x0 = 46;
  const x1 = w - 40;
  const yTop = 72;
  const yBase = 232;
  const span = tMax - tMin || 1;
  const xOf = (iso) => x0 + ((Date.parse(iso) - tMin) / span) * (x1 - x0);
  const yOf = (stars) => yBase - (Math.log10(stars + 1) / Math.log10(maxStars + 1)) * (yBase - yTop);
  const rOf = (stars) => 2.4 + Math.sqrt(stars / maxStars) * 6.6;

  // 纵轴是对数 star 参考线，横轴是年份：让“越靠右越新、越靠上越受关注”读得出来。
  const guides = [1, 10, 100]
    .filter((s) => s <= maxStars)
    .map(
      (s) =>
        `  <line x1="${x0}" y1="${yOf(s).toFixed(1)}" x2="${x1}" y2="${yOf(s).toFixed(1)}" stroke="${t.grid}" stroke-width="1" stroke-dasharray="1 7"/>
  <text class="f cap mono" x="${x0 - 8}" y="${(yOf(s) + 3).toFixed(1)}" text-anchor="end">${s}</text>`,
    )
    .join("\n");

  const yearTicks = [];
  for (let y = new Date(tMin).getUTCFullYear(); y <= new Date(tMax).getUTCFullYear(); y += 1) {
    const at = Date.UTC(y, 0, 1);
    if (at < tMin || at > tMax) continue;
    const x = x0 + ((at - tMin) / span) * (x1 - x0);
    yearTicks.push(
      `  <line x1="${x.toFixed(1)}" y1="${yTop - 10}" x2="${x.toFixed(1)}" y2="${yBase}" stroke="${t.grid}" stroke-width="1" stroke-dasharray="2 6"/>
  <text class="f cap mono" x="${x.toFixed(1)}" y="${yBase + 16}" text-anchor="middle">${y}</text>`,
    );
  }

  const dots = plotted
    .map((r, i) => {
      const cx = xOf(r.pushedAt);
      const cy = yOf(r.stargazerCount);
      const rr = rOf(r.stargazerCount);
      const color = r.primaryLanguage?.color ?? t.faint;
      const halo =
        r.stargazerCount >= maxStars / 8
          ? `  <circle class="glow" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(rr * 2.3).toFixed(1)}" fill="${color}" opacity=".18" style="animation-delay:${(i % 7) * 600}ms"/>\n`
          : "";
      return `${halo}  <circle class="pop" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rr.toFixed(1)}" fill="${color}" opacity=".92" style="animation-delay:${i * 22}ms"/>`;
    })
    .join("\n");

  // 只给前 5 名标注：再多就互相压字了。
  const labels = d.topRepos
    .slice(0, 5)
    .map((r, i) => {
      const cx = xOf(r.pushedAt);
      const cy = yOf(r.stargazerCount);
      const flip = cx > w - 190;
      const tx = flip ? cx - rOf(r.stargazerCount) - 8 : cx + rOf(r.stargazerCount) + 8;
      return `  <text class="d sm mono pop" x="${tx.toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" text-anchor="${flip ? "end" : "start"}" style="animation-delay:${900 + i * 120}ms">${esc(r.name)} · ${nf(r.stargazerCount)}★</text>`;
    })
    .join("\n");

  const langLegend = d.langs
    .slice(0, 7)
    .map((l, i) => {
      const x = 46 + i * 118;
      return `  <circle cx="${x + 4}" cy="${h - 16}" r="4" fill="${l.color ?? t.faint}"/>
  <text class="f cap mono" x="${x + 13}" y="${h - 12}">${esc(l.name.toUpperCase())}</text>`;
    })
    .join("\n");

  const body = `  <text class="f cap mono" x="46" y="50">X = LAST PUSH · Y = STARS (LOG SCALE) · COLOR = PRIMARY LANGUAGE</text>
${yearTicks.join("\n")}
${guides}
  <line x1="${x0}" y1="${yBase + 1}" x2="${x1}" y2="${yBase + 1}" stroke="${t.stroke}" stroke-width="1"/>
${dots}
${labels}
${langLegend}`;

  return {
    file: `constellation-${t.id}.svg`,
    svg: shell({ t, w, h, title: "repository constellation", subtitle: `${nf(plotted.length)} repos`, body }),
  };
}

/* ---------------------------------------------------- 卡片：旗舰构建脉搏 */

function flagshipCard(t, d, stamp, build) {
  const w = 430;
  const h = 250;
  const repo = d.flagship;
  if (!repo) throw new Error("没有任何仓库发过 release，无法生成旗舰卡");
  const rel = build;
  const assets = rel.releaseAssets;
  const bytes = assets.nodes.reduce((s, a) => s + a.size, 0);
  const downloads = assets.nodes.reduce((s, a) => s + a.downloadCount, 0);
  const ageH = Math.max(0, Math.round((Date.now() - Date.parse(rel.publishedAt)) / 36e5));

  const rows = [
    ["release", clip(rel.tagName, 26)],
    ["built", `${day(rel.publishedAt)} · ${ageH}h ago`],
    ["artifacts", assets.totalCount > 0 ? `${assets.totalCount} files · ${mb(bytes)}` : "source only"],
    ["downloads", downloads > 0 ? `${nf(downloads)} on this build` : "—"],
    ["adoption", `${nf(repo.stargazerCount)} stars · ${nf(repo.forkCount)} forks`],
  ];
  const rowSvg = rows
    .map(([k, v], i) => {
      const y = 118 + i * 24;
      return `  <text class="f cap mono" x="26" y="${y}">${esc(k.toUpperCase())}</text>
  <text class="t sm mono" x="150" y="${y}">${esc(v)}</text>`;
    })
    .join("\n");

  const body = `  <text class="t" x="26" y="58" font-size="15" font-weight="600">${esc(clip(repo.name, 28))}</text>
  <text class="d sm" x="26" y="76">${esc(clip(repo.description ?? "no description", 50))}</text>
  <g opacity=".85">
    <polyline points="${wave({ x: 26, y: 96, width: w - 52, amp: 7, periods: 6 })}" fill="none" stroke="url(#edge)" stroke-width="1.4"/>
    <circle class="glow" cx="${w - 30}" cy="96" r="3.5" fill="${t.good}"/>
  </g>
${rowSvg}
  <text class="f cap mono" x="26" y="238">MOST-STARRED SHIPPING REPO · ${esc(stamp)}</text>`;

  return {
    file: `flagship-${t.id}.svg`,
    svg: shell({ t, w, h, title: "flagship build", subtitle: repo.name.toLowerCase(), body }),
  };
}

/* ------------------------------------------------------- README 动态区块 */

function marker(name, content, readme) {
  const start = `<!--START:${name}-->`;
  const end = `<!--END:${name}-->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error(`README 缺少 ${name} 标记`);
  return readme.slice(0, from + start.length) + "\n" + content.trim() + "\n" + readme.slice(to);
}

function launchesBlock(d) {
  const shipped = d.latestPerRepo.slice(0, 5).map(({ repo, release }) => {
    const assets = release.releaseAssets.totalCount;
    const tail = assets > 0 ? ` · ${assets} artifacts` : "";
    return `- **[${repo.name}](${repo.url})** [\`${clip(release.tagName, 24)}\`](${release.url}) — ${day(release.publishedAt)}${tail}`;
  });
  const moving = d.recent
    .slice(0, 5)
    .map((r) => `- **[${r.name}](${r.url})** — ${day(r.pushedAt)}${r.primaryLanguage ? ` · ${r.primaryLanguage.name}` : ""}`);

  return `<table>
<tr>
<td valign="top" width="50%">

**🚀 最近发布**

${shipped.join("\n")}

</td>
<td valign="top" width="50%">

**⚡ 最近推进**

${moving.join("\n")}

</td>
</tr>
</table>`;
}

function ledgerBlock(d) {
  const rows = d.topRepos
    .slice(0, 8)
    .map(
      (r) =>
        `| [${r.name}](${r.url}) | ${r.primaryLanguage?.name ?? "—"} | ${nf(r.stargazerCount)} | ${nf(r.forkCount)} | ${day(r.pushedAt)} | ${clip(r.description ?? "", 32) || "—"} |`,
    )
    .join("\n");
  return `| 仓库 | 语言 | Stars | Forks | 最近推送 | 一句话 |
|:--|:--|--:|--:|:--|:--|
${rows}`;
}

/* ------------------------------------------------------------------ 主流程 */

const user = await fetchFacts();
const d = digest(user);
if (!d.flagship) throw new Error("没有任何仓库发过 release");
const flagshipBuild = await fetchFlagshipBuild(d.flagship.name);
const stamp = new Date().toISOString().slice(0, 10);

const cards = [];
for (const t of Object.values(THEMES)) {
  cards.push(
    signalCard(t, d, stamp),
    rhythmCard(t, d),
    cadenceCard(t, d),
    constellationCard(t, d),
    flagshipCard(t, d, stamp, flagshipBuild),
  );
}
await Promise.all(cards.map((c) => writeFile(path.join(ROOT, "assets", c.file), c.svg, "utf8")));

const readmePath = path.join(ROOT, "README.md");
let readme = await readFile(readmePath, "utf8");
readme = marker("launches", launchesBlock(d), readme);
readme = marker("ledger", ledgerBlock(d), readme);
readme = marker(
  "stamp",
  `\`最后同步 ${stamp} · ${nf(d.repoCount)} repos · ${nf(d.stars)} stars · ${nf(d.contributionsYear)} contributions/12m\``,
  readme,
);
await writeFile(readmePath, readme, "utf8");

console.log(
  `已生成 ${cards.length} 张卡片 + 3 个 README 区块 | repos=${d.repoCount} stars=${d.stars} weeks=${d.weeks.length} releases=${d.timeline.length} flagship=${d.flagship?.name}`,
);
