// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Token Weather: a live forecast of the context window, above the prompt.
// Locally extended (carol-local-mods fork) to also show plan rate limits
// (e.g. the 5-hour session limit, weekly limits) and their reset countdown,
// on wide enough terminals.
//
// turn.complete: after each main-loop turn, read the context window's fill
// from $.session.usage() (the same figures the status line shows) and keep
// the last HISTORY readings.
// session.measure: fires after each turn and whenever a plan limit's percent
// used changes; used to refresh the rate-limit figures promptly.
// session.start: take a first reading, so the band shows before any turn.
// ui.render (AbovePrompt): one line: icon, forecast word, percent, tokens
// used of the window, a block-character chart of the recent turns, and
// (space permitting) the plan's rate limits with reset countdowns.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

const HISTORY = 12;
const BARS = "▁▂▃▄▅▆▇█";

// Forecast bands, by percent of the window used.
const FORECAST = [
// Single-width text symbols, not emoji: they line up in every terminal font.
  { upTo: 25, icon: "☀", word: "Clear", color: "yellow" },
  { upTo: 50, icon: "☁", word: "Cloudy", color: "cyan" },
  { upTo: 75, icon: "☂", word: "Showers", color: "blue" },
  { upTo: 90, icon: "☇", word: "Storm", color: "magenta" },
  { upTo: Infinity, icon: "↯", word: "Compact soon", color: "red" },
];

// Readings: { tokens, window, percent }, oldest first.
let readings = [];
// Latest plan rate limits: list of { kind, percentUsed, resetsAt }.
let rateLimits = [];
// Latest cost figure from $.session.usage(), if the host reports one.
let cost = null;

// Id of the side panel this mod opens, used to open/close it and to
// recognize it in the ui.render hook.
const PANEL = "token-weather-panel";

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    readings = [];
    await takeReading($);
    // Open our own panel. Opened by the mod itself (not a user action), so
    // per the mods interface rules it only appears on a wide enough window
    // the first time; it appears more readily once the user has opened it
    // themselves once (e.g. via /usage-panel).
    try {
      await $.ui.open({ id: PANEL, title: "Token Weather" });
    } catch {
      // Ignore: e.g. too narrow this time, or already open.
    }
    // Keep the reset countdowns in the panel ticking even between turns.
    $.clock.every(30_000, () => $.ui.invalidate("ui.render"));
    await $.command.register({ name: "usage-panel", description: "Open the Token Weather usage panel" });
    return result;
  });

  on("command.run", { command: "usage-panel" }, async ($) => {
    await $.ui.open({ id: PANEL, title: "Token Weather", focus: true, closeOnEscape: true });
    return {};
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) {
      return result;
    }
    await takeReading($);
    return result;
  });

  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    await takeReading($);
    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.hasSurvey || readings.length === 0) {
      return next(e);
    }
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, e.bodyColumns ?? 80);
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (e.requestId !== PANEL) {
      return next(e);
    }
    const { Box, Text } = $.ui.resolve(e);
    return panel(Box, Text);
  });
}

async function takeReading($) {
  try {
    const usage = await $.session.usage();
    const { context, rateLimits: limits } = usage;
    if (Array.isArray(limits)) {
      rateLimits = limits;
    }
    if (usage.cost != null) {
      cost = usage.cost;
    }
    if (!context || !context.window) {
      return;
    }
    const tokens = context.tokens ?? 0;
    const percent = Math.round(context.percent ?? (tokens / context.window) * 100);
    // The session.start reading is 0 before any response; drop it once real readings arrive.
    readings = readings.filter((r) => r.tokens > 0);
    readings.push({ tokens, window: context.window, percent });
    if (readings.length > HISTORY) {
      readings = readings.slice(-HISTORY);
    }
    $.ui.invalidate("ui.render");
  } catch {
    // No reading this turn; the band and panel keep the last one.
  }
}

// e.g. "five_hour" -> "Session", "seven_day_all_models" -> "Week", "seven_day_opus" -> "Week-Opus"
function labelFor(kind) {
  const k = String(kind || "").toLowerCase();
  if (k.includes("hour")) return "Session";
  if (k.includes("week") || k.includes("seven_day")) {
    const modelMatch = k.match(/seven_day_([a-z0-9]+)/);
    const model = modelMatch && modelMatch[1] !== "all" && modelMatch[1] !== "models" ? modelMatch[1] : null;
    return model ? `Week-${model[0].toUpperCase()}${model.slice(1)}` : "Week";
  }
  return k || "Limit";
}

function fmtReset(resetsAt) {
  if (!resetsAt) return "";
  let ms = typeof resetsAt === "number" ? (resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

function rateLimitParts(Text) {
  if (!rateLimits.length) return [];
  return rateLimits.slice(0, 2).map((rl) => {
    const used = Math.round(rl.percentUsed ?? 0);
    const reset = fmtReset(rl.resetsAt);
    const label = labelFor(rl.kind);
    const urgent = used >= 90;
    return Text({
      dimColor: !urgent,
      color: urgent ? "red" : undefined,
      children: `  ${label} ${used}%${reset ? ` (${reset})` : ""}`,
    });
  });
}

// One row per rate limit, full label, percent, reset countdown and a small
// text progress bar -- more room than the band gets, so nothing is cut.
function rateLimitRows(Box, Text) {
  if (!rateLimits.length) {
    return [Text({ dimColor: true, children: "(no plan limit data yet)" })];
  }
  return rateLimits.map((rl, i) => {
    const used = Math.round(rl.percentUsed ?? 0);
    const reset = fmtReset(rl.resetsAt);
    const label = labelFor(rl.kind);
    const urgent = used >= 90;
    const filled = Math.round((used / 100) * 10);
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    return Box({
      key: "rl-" + i,
      flexDirection: "row",
      columnGap: 1,
      children: [
        Text({ color: urgent ? "red" : undefined, bold: urgent, children: bar }),
        Text({ children: `${label} ${used}%` }),
        reset ? Text({ dimColor: true, children: `resets ${reset}` }) : Text({ children: "" }),
      ],
    });
  });
}

function panel(Box, Text) {
  if (readings.length === 0) {
    return Text({ dimColor: true, children: "Waiting for the first reply…" });
  }
  const now = readings[readings.length - 1];
  const f = forecastFor(now.percent);
  const trend = trendWord();

  const rows = [
    Box({
      flexDirection: "row",
      columnGap: 1,
      children: [
        Text({ color: f.color, bold: true, children: `${f.icon} ${f.word}` }),
        Text({ children: `${now.percent}% of context` }),
      ],
    }),
    Text({ dimColor: true, children: `${short(now.tokens)} / ${short(now.window)} tokens` }),
    Text({ color: f.color, children: chart() }),
  ];
  if (trend) {
    rows.push(Text({ dimColor: true, children: trend }));
  }
  rows.push(Text({ children: " " }));
  rows.push(Text({ dimColor: true, children: "Plan limits" }));
  rows.push(...rateLimitRows(Box, Text));
  if (cost != null) {
    const amount = typeof cost === "number" ? cost : cost.totalCostUsd ?? cost.total ?? null;
    if (amount != null) {
      rows.push(Text({ children: " " }));
      rows.push(Text({ dimColor: true, children: `Session cost: $${Number(amount).toFixed(2)}` }));
    }
  }

  return Box({ flexDirection: "column", rowGap: 1, children: rows });
}

function band(Box, Text, columns) {
  const now = readings[readings.length - 1];
  const f = forecastFor(now.percent);
  const trend = trendWord();
  const parts = [
    Text({ color: f.color, bold: true, children: `${f.icon}  ${f.word}` }),
    Text({ children: `  ${now.percent}% of context` }),
    Text({ dimColor: true, children: `  ${short(now.tokens)} / ${short(now.window)}` }),
  ];
  if (columns >= 60) {
    parts.push(Text({ dimColor: true, children: "   last turns " }));
    parts.push(Text({ color: f.color, children: chart() }));
    if (trend) {
      parts.push(Text({ dimColor: true, children: `  ${trend}` }));
    }
  }
  if (columns >= 90) {
    parts.push(Text({ dimColor: true, children: "  │" }));
    parts.push(...rateLimitParts(Text));
  }
  return Box({ flexDirection: "row", paddingX: 1, children: parts });
}

function forecastFor(percent) {
  return FORECAST.find((band) => percent < band.upTo) ?? FORECAST[FORECAST.length - 1];
}

// Bars scale to the busiest reading shown, so growth shows at any fill level.
function chart() {
  const top = Math.max(...readings.map((r) => r.tokens), 1);
  const bars = readings.map((r) => BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))]);
  return bars.join("");
}

function trendWord() {
  if (readings.length < 2) {
    return "";
  }
  const delta = readings[readings.length - 1].tokens - readings[readings.length - 2].tokens;
  if (delta > 0) return `▲ +${short(delta)} last turn`;
  if (delta < 0) return `▼ ${short(-delta)} last turn`;
  return "steady";
}

function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}
