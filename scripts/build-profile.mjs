#!/usr/bin/env node
/**
 * 个人主页资产生成器。
 *
 * 设计取舍：
 *   - 公共卡片服务（github-readme-stats / trophy / activity-graph）已长期不可用，
 *     因此所有数据卡都在本仓库内自产，README 只引用自己的产物，杜绝破图。
 *   - 一次 GraphQL 请求取全部事实（用户 + 自有公开仓库 + 每仓库最新 release），
 *     避免 74 次 REST 往返，同时把速率消耗压到 1 次。
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
      contributionCalendar { totalContributions }
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
        isArchived
        primaryLanguage { name color }
        releases(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes {
            tagName
            publishedAt
            url
            releaseAssets(first: 100) { totalCount nodes { size downloadCount } }
          }
        }
      }
    }
  }
}`;

async function fetchFacts() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": `${LOGIN}-profile-builder`,
    },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(body.errors).slice(0, 300)}`);
  if (!body.data?.user) throw new Error("GraphQL 返回空 user");
  return body.data.user;
}

/* ---------------------------------------------------------------- 事实整理 */

function digest(user) {
  const repos = user.repositories.nodes.filter(Boolean);
  const active = repos.filter((r) => !r.isArchived);
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
  const langTotal = langs.reduce((s, l) => s + l.count, 0);

  const releases = repos
    .map((r) => ({ repo: r, release: r.releases.nodes[0] }))
    .filter((x) => x.release?.publishedAt)
    .sort((a, b) => Date.parse(b.release.publishedAt) - Date.parse(a.release.publishedAt));

  return {
    login: user.login,
    name: user.name,
    since: user.createdAt.slice(0, 7),
    followers: user.followers.totalCount,
    contributionsYear: user.contributionsCollection.contributionCalendar.totalContributions,
    repoCount: user.repositories.totalCount,
    stars,
    forks,
    langs,
    langTotal,
    releases,
    recent: active.slice(0, 6),
    byName: new Map(repos.map((r) => [r.name, r])),
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
    text: "#eef1f7",
    dim: "#a8b3c4",
    faint: "#7d8899",
    accent: "#ffc857",
    accent2: "#e5657f",
    good: "#7fd6a3",
  },
  light: {
    id: "light",
    bg0: "#fdfbf6",
    bg1: "#efe8ef",
    stroke: "#ded3d0",
    text: "#201a22",
    dim: "#5c5158",
    faint: "#8d8189",
    accent: "#c9821a",
    accent2: "#b34a63",
    good: "#157f52",
  },
};

const MONO = "'JetBrains Mono','Fira Code','SFMono-Regular',ui-monospace,Menlo,Consolas,monospace";
const SANS = "'Noto Sans SC','PingFang SC','Microsoft YaHei','Segoe UI',Helvetica,Arial,sans-serif";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const day = (iso) => iso.slice(0, 10);
const nf = (n) => n.toLocaleString("en-US");

/** 生成一条平滑的正弦折线，用作“信号/脉搏”底纹。 */
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

/** 卡片外框 + 共用滤镜/样式。所有动画都是纯 CSS，<img> 上下文里没有 JS。 */
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
    .drift { animation: drift 14s linear infinite; }
    .glow { animation: glow 4.5s ease-in-out infinite; }
    .grow { transform-box: fill-box; transform-origin: left center; animation: grow 1.6s cubic-bezier(.22,1,.36,1) both; }
    @media (prefers-reduced-motion: reduce) {
      .drift, .glow, .grow { animation: none; }
      .grow { transform: none; }
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

/* ------------------------------------------------------------ 卡片一：信号台 */

function signalCard(t, d, stamp) {
  const w = 430;
  const h = 250;
  const kpis = [
    ["repos", nf(d.repoCount)],
    ["stars", nf(d.stars)],
    ["forks", nf(d.forks)],
    ["followers", nf(d.followers)],
  ];
  const kpiSvg = kpis
    .map(([cap, val], i) => {
      const x = 26 + i * 100;
      return `  <text class="t kpi mono" x="${x}" y="72">${esc(val)}</text>
  <text class="f cap mono" x="${x}" y="87">${esc(cap.toUpperCase())}</text>`;
    })
    .join("\n");

  // 语言光谱：前 6 名 + 其余归并，宽度按仓库数占比。
  const top = d.langs.slice(0, 6);
  const restCount = d.langTotal - top.reduce((s, l) => s + l.count, 0);
  const bars = [...top, ...(restCount > 0 ? [{ name: "other", color: t.faint, count: restCount }] : [])];
  const barW = w - 52;
  let cursor = 26;
  const spectrum = bars
    .map((l, i) => {
      const width = Math.max(3, (l.count / d.langTotal) * barW);
      const seg = `  <rect class="grow" x="${cursor.toFixed(1)}" y="118" width="${width.toFixed(1)}" height="10" rx="3" fill="${l.color ?? t.faint}" style="animation-delay:${(i * 90).toFixed(0)}ms"/>`;
      cursor += width;
      return seg;
    })
    .join("\n");

  const legend = bars
    .slice(0, 6)
    .map((l, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 26 + col * 135;
      const y = 152 + row * 19;
      return `  <circle cx="${x + 4}" cy="${y - 3.5}" r="4" fill="${l.color ?? t.faint}"/>
  <text class="d sm mono" x="${x + 14}" y="${y}">${esc(l.name)} · ${l.count}</text>`;
    })
    .join("\n");

  const body = `${kpiSvg}
  <text class="f cap mono" x="26" y="108">PRIMARY LANGUAGE PER OWN REPO</text>
${spectrum}
${legend}
  <g opacity=".5">
    <polyline class="drift" points="${wave({ x: -160, y: 218, width: w + 340, amp: 9, periods: 5.5 })}" fill="none" stroke="url(#edge)" stroke-width="1.6"/>
  </g>
  <text class="f cap mono" x="26" y="238">SINCE ${esc(d.since)} · ${nf(d.contributionsYear)} CONTRIBUTIONS / 12M</text>
  <text class="f cap mono" x="${w - 16}" y="238" text-anchor="end">${esc(stamp)}</text>`;

  return { file: `signal-${t.id}.svg`, svg: shell({ t, w, h, title: "signal board", subtitle: `@${d.login}`, body }) };
}

/* ------------------------------------------------------ 卡片二：规则脉搏 */

function pulseCard(t, d, stamp) {
  const w = 430;
  const h = 250;
  const repo = d.byName.get("HyperADRules");
  if (!repo) throw new Error("HyperADRules 不在仓库列表里，无法生成规则脉搏卡");
  const rel = repo.releases.nodes[0];
  if (!rel) throw new Error("HyperADRules 没有 release，无法生成规则脉搏卡");
  const assets = rel.releaseAssets;
  const bytes = assets.nodes.reduce((s, a) => s + a.size, 0);
  const downloads = assets.nodes.reduce((s, a) => s + a.downloadCount, 0);
  const ageH = Math.max(0, Math.round((Date.now() - Date.parse(rel.publishedAt)) / 36e5));

  const rows = [
    ["release", rel.tagName],
    ["built", `${day(rel.publishedAt)} · ${ageH}h ago`],
    ["artifacts", `${assets.totalCount} files · ${mb(bytes)}`],
    ["downloads", `${nf(downloads)} on this build`],
    ["adoption", `${nf(repo.stargazerCount)} stars · ${nf(repo.forkCount)} forks`],
  ];
  const rowSvg = rows
    .map(([k, v], i) => {
      const y = 118 + i * 24;
      return `  <text class="f cap mono" x="26" y="${y}">${esc(k.toUpperCase())}</text>
  <text class="t sm mono" x="150" y="${y}">${esc(v)}</text>`;
    })
    .join("\n");

  const body = `  <text class="t" x="26" y="58" font-size="15" font-weight="600">HyperADRules</text>
  <text class="d sm" x="26" y="76">多上游合并 → mihomo MRS · sing-box SRS · Clash · AdGuard</text>
  <g opacity=".85">
    <polyline points="${wave({ x: 26, y: 96, width: w - 52, amp: 7, periods: 6 })}" fill="none" stroke="url(#edge)" stroke-width="1.4"/>
    <circle class="glow" cx="${w - 30}" cy="96" r="3.5" fill="${t.good}"/>
  </g>
${rowSvg}
  <text class="f cap mono" x="26" y="238">DAILY SNAPSHOT PIPELINE · SNAPSHOT ${esc(stamp)}</text>`;

  return { file: `pulse-${t.id}.svg`, svg: shell({ t, w, h, title: "rule pulse", subtitle: "hyperadrules", body }) };
}

/* --------------------------------------------------- 卡片三：MCP 握手名片 */

function handshakeCard(t, d) {
  const w = 880;
  const h = 250;
  const repo = d.byName.get("OneSSH");
  const rel = repo?.releases.nodes[0];
  const version = rel?.tagName ?? "main";

  // 每一行都对应 OneSSH 的公开能力，不编造运行时状态；卡片标注 architecture 而非 live。
  // 列坐标显式给出：SVG 会折叠连续空格，靠空格对齐必然错位。
  const lines = [
    ["$", "", "onessh mcp attach --agent coding-agent", t.text],
    ["→", "gateway", "centralized SSH · one audited entry point", t.dim],
    ["→", "tools", "exec · file_edit · grep · job_start · memory_recall", t.dim],
    ["→", "credentials", "vault-held · never handed to the model", t.dim],
    ["→", "authz", "per-token host allowlist + tag scopes", t.dim],
    ["→", "audit", "every call appended to the trail", t.dim],
    ["✓", "", `handshake complete — OneSSH ${version}`, t.good],
  ];

  const rowSvg = lines
    .map(([mark, label, value, fill], i) => {
      const y = 70 + i * 22;
      const last = i === lines.length - 1;
      const labelSvg = label
        ? `    <text class="f cap mono" x="46" y="${y}">${esc(label.toUpperCase())}</text>\n`
        : "";
      return `  <g class="line" style="animation-delay:${(i * 260).toFixed(0)}ms">
    <text class="mono" x="26" y="${y}" font-size="12.5" fill="${last ? t.good : t.accent}">${esc(mark)}</text>
${labelSvg}    <text class="mono" x="${label ? 160 : 46}" y="${y}" font-size="12.5" fill="${fill}">${esc(value)}</text>
  </g>`;
    })
    .join("\n");

  const extraStyle = `    @keyframes reveal { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
    .line { animation: reveal .5s ease-out both; }
    @keyframes blink { 0%,49% { opacity: 1; } 50%,100% { opacity: 0; } }
    .caret { animation: blink 1.1s steps(1) infinite; }
    @media (prefers-reduced-motion: reduce) {
      .line { animation: none; opacity: 1; transform: none; }
      .caret { animation: none; }
    }`;

  // 末行留一个等待输入的提示符：卡片是快照，但网关一直在那儿。
  const promptY = 70 + lines.length * 22;
  const body = `${rowSvg}
  <g class="line" style="animation-delay:${(lines.length * 260).toFixed(0)}ms">
    <text class="mono" x="26" y="${promptY}" font-size="12.5" fill="${t.accent}">$</text>
    <rect class="caret" x="46" y="${promptY - 10}" width="7" height="12" fill="${t.accent2}"/>
  </g>
  <g opacity=".22">
    <polyline class="drift" points="${wave({ x: -160, y: h - 12, width: w + 340, amp: 5, periods: 9 })}" fill="none" stroke="url(#edge)" stroke-width="1.2"/>
  </g>`;

  return {
    file: `handshake-${t.id}.svg`,
    svg: shell({ t, w, h, title: "agent handshake", subtitle: "architecture snapshot", body, extraStyle }),
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
  const shipped = d.releases.slice(0, 5).map(({ repo, release }) => {
    const assets = release.releaseAssets.totalCount;
    const tail = assets > 0 ? ` · ${assets} artifacts` : "";
    return `- **[${repo.name}](${repo.url})** [\`${release.tagName}\`](${release.url}) — ${day(release.publishedAt)}${tail}`;
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
  const top = [...d.byName.values()].sort((a, b) => b.stargazerCount - a.stargazerCount).slice(0, 6);
  const rows = top
    .map(
      (r) =>
        `| [${r.name}](${r.url}) | ${r.primaryLanguage?.name ?? "—"} | ${nf(r.stargazerCount)} | ${nf(r.forkCount)} | ${day(r.pushedAt)} |`,
    )
    .join("\n");
  return `| 仓库 | 语言 | Stars | Forks | 最近推送 |
|:--|:--|--:|--:|:--|
${rows}`;
}

/* ------------------------------------------------------------------ 主流程 */

const user = await fetchFacts();
const d = digest(user);
const stamp = new Date().toISOString().slice(0, 10);

const cards = [];
for (const t of Object.values(THEMES)) {
  cards.push(signalCard(t, d, stamp), pulseCard(t, d, stamp), handshakeCard(t, d));
}
await Promise.all(cards.map((c) => writeFile(path.join(ROOT, "assets", c.file), c.svg, "utf8")));

const readmePath = path.join(ROOT, "README.md");
let readme = await readFile(readmePath, "utf8");
readme = marker("launches", launchesBlock(d), readme);
readme = marker("ledger", ledgerBlock(d), readme);
readme = marker("stamp", `\`最后同步 ${stamp} · ${nf(d.repoCount)} repos · ${nf(d.stars)} stars\``, readme);
await writeFile(readmePath, readme, "utf8");

console.log(
  `已生成 ${cards.length} 张卡片 + 3 个 README 区块 | repos=${d.repoCount} stars=${d.stars} langs=${d.langs.length} releases=${d.releases.length}`,
);
