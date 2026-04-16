const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3001;

// Povoliť len požiadavky z lokálnej siete (192.168.x.x) a localhost
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.startsWith('http://192.168.') || origin.startsWith('http://localhost') || origin.startsWith('http://127.')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
}));
app.use(express.json());

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// ── Pricing ───────────────────────────────────────────────────────────────────

const PRICING = {
  'claude-opus-4-6':  { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-opus-4-5':  { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-6':{ input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-sonnet-4-5':{ input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5': { input: 0.80, output: 4,   cacheWrite: 1.00,  cacheRead: 0.08 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4, cacheWrite: 1.00, cacheRead: 0.08 },
};

const SONNET_INPUT_PRICE = 3; // per million tokens, used for cache savings estimate

function getPricing(model) {
  if (!model) return null;
  // Exact match first
  if (PRICING[model]) return PRICING[model];
  // Prefix match for date-versioned models
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  // Fallback by family
  if (model.includes('opus')) return PRICING['claude-opus-4-5'];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-5'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5'];
  return null;
}

function calcCost(usage, model) {
  const price = getPricing(model);
  if (!price || !usage) return 0;
  const input = (usage.input_tokens || 0) / 1e6 * price.input;
  const output = (usage.output_tokens || 0) / 1e6 * price.output;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1e6 * price.cacheWrite;
  const cacheRead = (usage.cache_read_input_tokens || 0) / 1e6 * price.cacheRead;
  return input + output + cacheWrite + cacheRead;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean);
  const results = [];
  for (const line of lines) {
    try { results.push(JSON.parse(line)); } catch (_) {}
  }
  return results;
}

function getProjectDirs() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR)
    .filter(d => fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory());
}

function pathFromDirName(dirName) {
  return dirName.replace(/-/g, '/');
}

function projectNameFromPath(p) {
  return p.split('/').filter(Boolean).pop() || p;
}

function getSessionsForProject(projectDir) {
  const indexFile = path.join(PROJECTS_DIR, projectDir, 'sessions-index.json');
  if (!fs.existsSync(indexFile)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    const sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
    return sessions.map(s => ({
      ...s,
      projectDir,
      projectPath: pathFromDirName(projectDir),
      projectName: projectNameFromPath(pathFromDirName(projectDir)),
    }));
  } catch (_) { return []; }
}

function normalizeEntry(entry) {
  return {
    ...entry,
    prompt: entry.prompt || entry.display || '',
    projectPath: entry.projectPath || entry.project || '',
    timestamp: entry.timestamp
      ? (typeof entry.timestamp === 'number'
          ? new Date(entry.timestamp).toISOString()
          : entry.timestamp)
      : '',
  };
}

function buildActivity(history, days = 90) {
  const map = {};
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    map[key] = { date: key, sessions: 0, prompts: 0 };
  }
  for (const entry of history) {
    if (!entry.timestamp) continue;
    const key = new Date(entry.timestamp).toISOString().slice(0, 10);
    if (map[key]) map[key].prompts++;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

function buildProjectStats(history, sessions) {
  const stats = {};
  for (const entry of history) {
    const p = entry.projectPath || 'unknown';
    if (!stats[p]) stats[p] = { path: p, name: projectNameFromPath(p), sessionCount: 0, promptCount: 0, lastActive: entry.timestamp || '' };
    stats[p].promptCount++;
    if (entry.timestamp > stats[p].lastActive) stats[p].lastActive = entry.timestamp;
  }
  for (const s of sessions) {
    const p = s.projectPath || 'unknown';
    if (!stats[p]) stats[p] = { path: p, name: s.projectName || projectNameFromPath(p), sessionCount: 0, promptCount: 0, lastActive: s.updatedAt || '' };
    stats[p].sessionCount++;
  }
  return Object.values(stats).sort((a, b) => b.promptCount - a.promptCount);
}

// ── Session JSONL parsing ─────────────────────────────────────────────────────

function extractFilePathFromToolUse(toolName, input) {
  if (!input) return null;
  if (['Read', 'Write', 'Edit'].includes(toolName)) {
    return input.file_path || null;
  }
  if (toolName === 'Glob') {
    const p = input.pattern || '';
    if (p && !p.includes('*')) return p;
    return null;
  }
  if (toolName === 'Grep') {
    const p = input.path || '';
    if (p && p.startsWith('/')) return p;
    return null;
  }
  return null;
}

function parseSessionFile(filePath) {
  const rawEntries = readJsonl(filePath);

  // Deduplicate assistant messages by message.id
  // - Token usage: use the LAST entry for each message.id
  // - Content/tool_use blocks: accumulate from ALL entries
  const assistantMessages = new Map(); // messageId -> { entry, contentBlocks }

  const userMessages = [];
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const entry of rawEntries) {
    if (entry.type === 'file-history-snapshot') continue;

    // Track timestamps from any entry
    const ts = entry.timestamp;
    if (ts) {
      const t = typeof ts === 'number' ? ts : new Date(ts).getTime();
      if (!firstTimestamp || t < firstTimestamp) firstTimestamp = t;
      if (!lastTimestamp || t > lastTimestamp) lastTimestamp = t;
    }

    if (entry.type === 'user') {
      userMessages.push(entry);
    } else if (entry.type === 'assistant' && entry.message && entry.message.id) {
      const msgId = entry.message.id;
      if (!assistantMessages.has(msgId)) {
        assistantMessages.set(msgId, {
          latestEntry: entry,
          allContent: [],
        });
      }
      const stored = assistantMessages.get(msgId);
      // Always update to get the latest usage (final output_tokens)
      stored.latestEntry = entry;
      // Accumulate content blocks
      if (Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          stored.allContent.push(block);
        }
      }
    }
  }

  // Aggregate stats
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const toolNames = {};
  const filePaths = {};
  let model = null;
  const hourCounts = {};

  for (const [, { latestEntry, allContent }] of assistantMessages) {
    const msg = latestEntry.message;
    const usage = msg.usage || {};
    const msgModel = msg.model || latestEntry.model;
    if (msgModel && !model) model = msgModel;

    totalInput += usage.input_tokens || 0;
    totalOutput += usage.output_tokens || 0;
    totalCacheWrite += usage.cache_creation_input_tokens || 0;
    totalCacheRead += usage.cache_read_input_tokens || 0;
    totalCost += calcCost(usage, msgModel || model);

    // Count tool uses from accumulated content
    for (const block of allContent) {
      if (block.type === 'tool_use') {
        toolCalls++;
        const name = block.name || 'unknown';
        toolNames[name] = (toolNames[name] || 0) + 1;

        const fp = extractFilePathFromToolUse(name, block.input);
        if (fp) filePaths[fp] = (filePaths[fp] || 0) + 1;
      }
    }

    // Count tool errors from user messages (tool_result with is_error)
    const ts = latestEntry.timestamp;
    if (ts) {
      const hour = new Date(typeof ts === 'number' ? ts : ts).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
  }

  // Count tool errors from user messages
  for (const entry of userMessages) {
    const content = entry.message?.content || [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && block.is_error) {
          toolErrors++;
        }
      }
    }
    const ts = entry.timestamp;
    if (ts) {
      const hour = new Date(typeof ts === 'number' ? ts : ts).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
  }

  const duration = (firstTimestamp && lastTimestamp) ? (lastTimestamp - firstTimestamp) : 0;
  const messageCount = userMessages.length + assistantMessages.size;

  return {
    totalInput,
    totalOutput,
    totalCacheWrite,
    totalCacheRead,
    totalCost,
    toolCalls,
    toolErrors,
    toolNames,
    filePaths,
    hourCounts,
    model,
    duration,
    messageCount,
    firstTimestamp,
    lastTimestamp,
  };
}

// ── Analytics cache ───────────────────────────────────────────────────────────

let analyticsCache = null;
let analyticsCacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

function computeAnalytics() {
  const now = Date.now();
  if (analyticsCache && (now - analyticsCacheTime) < CACHE_TTL) {
    return analyticsCache;
  }

  const history = readJsonl(HISTORY_FILE).map(normalizeEntry);
  const dirs = getProjectDirs();

  // Per-day token maps (last 90 days)
  const today = new Date().toISOString().slice(0, 10);
  const dayMap = {};
  for (let i = 0; i < 90; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayMap[key] = { date: key, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
  }

  // Aggregate totals
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0, totalCost = 0;
  const projectCosts = {}; // projectPath -> { cost, input, output }
  const toolCounts = {};   // toolName -> count
  let totalToolCalls = 0;
  let totalToolErrors = 0;
  const fileHotspots = {}; // filePath -> count
  const hourDistribution = {}; // hour -> count
  const modelStats = {};   // model -> { sessionCount, input, output, cost }

  // Heavy sessions list
  const heavySessions = [];

  for (const dir of dirs) {
    const projectPath = pathFromDirName(dir);
    const projectName = projectNameFromPath(projectPath);

    // Get all JSONL files (sessions) in this dir
    const dirPath = path.join(PROJECTS_DIR, dir);
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch (_) {}

    for (const sessionFile of sessionFiles) {
      const sessionId = sessionFile.replace('.jsonl', '');
      const filePath = path.join(dirPath, sessionFile);

      let stats;
      try {
        stats = parseSessionFile(filePath);
      } catch (_) {
        continue;
      }

      if (!stats) continue;

      // Determine the date for this session
      let sessionDate = null;
      if (stats.firstTimestamp) {
        sessionDate = new Date(stats.firstTimestamp).toISOString().slice(0, 10);
      }

      // Add to day map
      if (sessionDate && dayMap[sessionDate]) {
        dayMap[sessionDate].input += stats.totalInput;
        dayMap[sessionDate].output += stats.totalOutput;
        dayMap[sessionDate].cacheWrite += stats.totalCacheWrite;
        dayMap[sessionDate].cacheRead += stats.totalCacheRead;
        dayMap[sessionDate].cost += stats.totalCost;
      }

      // Totals
      totalInput += stats.totalInput;
      totalOutput += stats.totalOutput;
      totalCacheWrite += stats.totalCacheWrite;
      totalCacheRead += stats.totalCacheRead;
      totalCost += stats.totalCost;

      // Project costs
      if (!projectCosts[projectPath]) {
        projectCosts[projectPath] = { path: projectPath, name: projectName, cost: 0, input: 0, output: 0 };
      }
      projectCosts[projectPath].cost += stats.totalCost;
      projectCosts[projectPath].input += stats.totalInput;
      projectCosts[projectPath].output += stats.totalOutput;

      // Tools
      totalToolCalls += stats.toolCalls;
      totalToolErrors += stats.toolErrors;
      for (const [name, count] of Object.entries(stats.toolNames)) {
        toolCounts[name] = (toolCounts[name] || 0) + count;
      }

      // File hotspots
      for (const [fp, count] of Object.entries(stats.filePaths)) {
        fileHotspots[fp] = (fileHotspots[fp] || 0) + count;
      }

      // Hour distribution
      for (const [hour, count] of Object.entries(stats.hourCounts)) {
        const h = parseInt(hour);
        hourDistribution[h] = (hourDistribution[h] || 0) + count;
      }

      // Model stats
      if (stats.model) {
        if (!modelStats[stats.model]) {
          modelStats[stats.model] = { model: stats.model, sessionCount: 0, input: 0, output: 0, cost: 0 };
        }
        modelStats[stats.model].sessionCount++;
        modelStats[stats.model].input += stats.totalInput;
        modelStats[stats.model].output += stats.totalOutput;
        modelStats[stats.model].cost += stats.totalCost;
      }

      // Heavy sessions (track all for top-10 selection)
      if (stats.totalCost > 0 || stats.totalInput > 0) {
        // Get first prompt from history for this session
        const historyEntry = history.find(e => e.sessionId === sessionId);
        const prompt = historyEntry?.prompt || '';
        heavySessions.push({
          sessionId,
          projectPath,
          prompt,
          cost: stats.totalCost,
          input: stats.totalInput,
          output: stats.totalOutput,
          toolCalls: stats.toolCalls,
          toolErrors: stats.toolErrors,
          duration: stats.duration,
          model: stats.model,
          timestamp: stats.firstTimestamp ? new Date(stats.firstTimestamp).toISOString() : null,
        });
      }
    }
  }

  // Sort and slice heavy sessions
  heavySessions.sort((a, b) => b.cost - a.cost);
  const topHeavySessions = heavySessions.slice(0, 10);

  // Session-level averages across all sessions
  const allSessionStats = heavySessions; // reuse
  const avgDuration = allSessionStats.length > 0
    ? allSessionStats.reduce((s, x) => s + (x.duration || 0), 0) / allSessionStats.length
    : 0;
  const avgToolCalls = allSessionStats.length > 0
    ? allSessionStats.reduce((s, x) => s + (x.toolCalls || 0), 0) / allSessionStats.length
    : 0;
  // avgMessages: we don't have per-session message counts aggregated here; skip or use 0
  const avgMessages = 0;

  // Cost by time periods
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let costToday = 0, costLast7d = 0, costLast30d = 0;
  for (const day of Object.values(dayMap)) {
    const d = new Date(day.date);
    if (day.date === today) costToday += day.cost;
    if (d >= sevenDaysAgo) costLast7d += day.cost;
    if (d >= thirtyDaysAgo) costLast30d += day.cost;
  }

  const projection30d = (costLast7d / 7) * 30;

  // Cache stats
  const cacheHitRate = (totalCacheRead + totalCacheWrite) > 0
    ? totalCacheRead / (totalCacheRead + totalCacheWrite)
    : 0;
  const savedCost = (totalCacheRead / 1e6) * SONNET_INPUT_PRICE;

  // Tool error rate
  const errorRate = totalToolCalls > 0 ? totalToolErrors / totalToolCalls : 0;

  // Hour distribution array 0-23
  const hoursArray = [];
  for (let h = 0; h < 24; h++) {
    hoursArray.push({ hour: h, count: hourDistribution[h] || 0 });
  }

  // File hotspots top 20
  const hotspots = Object.entries(fileHotspots)
    .map(([p, count]) => ({ path: p, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Tool breakdown top sorted
  const toolBreakdown = Object.entries(toolCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Model breakdown sorted by cost
  const modelBreakdown = Object.values(modelStats)
    .sort((a, b) => b.cost - a.cost);

  // Project costs sorted
  const byProject = Object.values(projectCosts)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);

  // byDay sorted
  const byDay = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  // Streak calculation from history
  const activeDatesSet = new Set(
    history
      .filter(e => e.timestamp)
      .map(e => new Date(e.timestamp).toISOString().slice(0, 10))
  );

  function calcStreak() {
    const todayStr = new Date().toISOString().slice(0, 10);
    let current = 0;
    let d = new Date();

    // If today has no activity, start from yesterday
    if (!activeDatesSet.has(todayStr)) {
      d.setDate(d.getDate() - 1);
    }

    while (true) {
      const key = d.toISOString().slice(0, 10);
      if (!activeDatesSet.has(key)) break;
      current++;
      d.setDate(d.getDate() - 1);
    }
    return current;
  }

  const streak = calcStreak();

  const result = {
    tokens: {
      total: { input: totalInput, output: totalOutput, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead },
      byDay,
    },
    cost: {
      total: totalCost,
      today: costToday,
      last7d: costLast7d,
      last30d: costLast30d,
      projection30d,
      byProject,
    },
    cache: {
      hitRate: cacheHitRate,
      totalReads: totalCacheRead,
      totalWrites: totalCacheWrite,
      savedCost,
    },
    tools: {
      breakdown: toolBreakdown,
      totalCalls: totalToolCalls,
      errorRate,
    },
    files: {
      hotspots,
    },
    hours: {
      distribution: hoursArray,
    },
    models: {
      breakdown: modelBreakdown,
    },
    sessions: {
      heavy: topHeavySessions,
      avgDuration,
      avgToolCalls,
      avgMessages,
    },
    streak: { current: streak },
  };

  analyticsCache = result;
  analyticsCacheTime = now;
  return result;
}

// Compute per-session cost map for history enrichment
function computeSessionCostMap() {
  const dirs = getProjectDirs();
  const map = {};

  for (const dir of dirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let sessionFiles = [];
    try {
      sessionFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    } catch (_) {}

    for (const sessionFile of sessionFiles) {
      const sessionId = sessionFile.replace('.jsonl', '');
      const filePath = path.join(dirPath, sessionFile);
      try {
        const stats = parseSessionFile(filePath);
        if (stats) {
          map[sessionId] = {
            sessionCost: stats.totalCost,
            sessionTokens: stats.totalInput + stats.totalOutput,
            sessionToolCalls: stats.toolCalls,
          };
        }
      } catch (_) {}
    }
  }

  return map;
}

let sessionCostMapCache = null;
let sessionCostMapCacheTime = 0;

function getSessionCostMap() {
  const now = Date.now();
  if (sessionCostMapCache && (now - sessionCostMapCacheTime) < CACHE_TTL) {
    return sessionCostMapCache;
  }
  sessionCostMapCache = computeSessionCostMap();
  sessionCostMapCacheTime = now;
  return sessionCostMapCache;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ ok: true, claudeDir: CLAUDE_DIR }));

app.get('/api/history', (req, res) => {
  const entries = readJsonl(HISTORY_FILE).map(normalizeEntry);
  const limit = parseInt(req.query.limit) || 500;
  const offset = parseInt(req.query.offset) || 0;
  const q = (req.query.q || '').toLowerCase();
  const project = req.query.project || '';

  let filtered = entries;
  if (q) filtered = filtered.filter(e => (e.prompt || '').toLowerCase().includes(q));
  if (project) filtered = filtered.filter(e => (e.projectPath || '').includes(project));

  const sorted = filtered.sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return tb - ta;
  });

  // Enrich with session cost data
  const sessionCostMap = getSessionCostMap();
  const enriched = sorted.slice(offset, offset + limit).map(e => {
    const extra = e.sessionId ? (sessionCostMap[e.sessionId] || {}) : {};
    return { ...e, ...extra };
  });

  res.json({
    total: sorted.length,
    offset,
    limit,
    items: enriched,
  });
});

app.get('/api/sessions', (req, res) => {
  const dirs = getProjectDirs();
  const all = dirs.flatMap(getSessionsForProject);
  all.sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });
  res.json({ total: all.length, items: all });
});

app.get('/api/session/:projectDir/:sessionId', (req, res) => {
  const { projectDir, sessionId } = req.params;
  const file = path.resolve(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
  if (!file.startsWith(PROJECTS_DIR + path.sep)) return res.status(403).json({ error: 'forbidden' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.json({ messages: readJsonl(file) });
});

app.get('/api/conversation/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const dirs = getProjectDirs();
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) {
      return res.json({ messages: readJsonl(file), projectDir: dir });
    }
  }
  res.status(404).json({ error: 'not found' });
});

app.get('/api/stats', (req, res) => {
  const history = readJsonl(HISTORY_FILE).map(normalizeEntry);
  const dirs = getProjectDirs();
  const sessions = dirs.flatMap(getSessionsForProject);
  const activity = buildActivity(history, 90);
  const projects = buildProjectStats(history, sessions);
  const activeDays = new Set(history.map(e => e.timestamp ? new Date(e.timestamp).toISOString().slice(0,10) : null).filter(Boolean)).size;

  // Add analytics summary
  let analyticsData = {};
  try {
    const analytics = computeAnalytics();
    analyticsData = {
      totalTokens: analytics.tokens.total.input + analytics.tokens.total.output,
      estimatedCost: analytics.cost.total,
      streak: analytics.streak.current,
    };
  } catch (_) {}

  res.json({
    meta: {
      totalPrompts: history.length,
      totalSessions: sessions.length,
      totalProjects: new Set(history.map(e => e.projectPath).filter(Boolean)).size,
      activeDays,
      claudeDir: CLAUDE_DIR,
      historyFile: HISTORY_FILE,
      hasData: history.length > 0,
      ...analyticsData,
    },
    activity,
    projects: projects.slice(0, 20),
  });
});

app.get('/api/projects', (req, res) => {
  const history = readJsonl(HISTORY_FILE).map(normalizeEntry);
  const dirs = getProjectDirs();
  const sessions = dirs.flatMap(getSessionsForProject);
  res.json({ items: buildProjectStats(history, sessions) });
});

app.get('/api/analytics', (req, res) => {
  try {
    const data = computeAnalytics();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  Claude Code Tracker API`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Reading from: ${CLAUDE_DIR}\n`);
});
