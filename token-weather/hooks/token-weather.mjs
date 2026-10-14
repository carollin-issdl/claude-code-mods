// Copyright 2026 Anthropic PBC
// SPDX-License-Identifier: Apache-2.0
//
// Token Weather: a live forecast of the context window, above the prompt.
// Locally extended (carol-local-mods fork) to also show plan rate limits
// (e.g. the 5-hour session limit, weekly limit) and their reset countdown,
// in the same band, on wide enough terminals.
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

export function register(on) {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    readings = [];
    await takeReading($);
    return result;
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
}

async function takeReading($) {
  try {
    const { context, rateLimits: limits } = await $.session.usage();
    if (Array.isArray(limits)) {
      rateLimits = limits;
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
    // No reading this turn; the band keeps the last one.
  }
}

// SessionRateLimit.kind is one of exactly three strings per Claude Code's
// own mods type declarations: "five_hour", "seven_day", or a gateway's
// "spend_limit". There is no per-model variant exposed to mods (the
// Desktop app's own "Weekly · Fable" row is drawn from data mods can't see).
function labelFor(kind) {
  const k = String(kind || "");
  if (k === "five_hour") return "Session";
  if (k === "seven_day") return "Week";
  if (k === "spend_limit") return "Spend";
  return k || "Limit";
}

function fmtReset(resetsAt) {
  if (!resetsAt) return "";
  // resetsAt is an ISO 8601 string per SessionRateLimit, but accept a raw
  // epoch value too in case a future host sends one.
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

function band(Box, Text, columns) {
  const now = readings[readings.length - 1];
  const f = forecastFor(now.percent);
  const trend = trendWord();
  // Plan limits are the figure asked for most, so they go right after the
  // headline numbers -- before the chart/trend, which are nice-to-haves and
  // are the first thing dropped on a narrower band.
  const parts = [
    Text({ color: f.color, bold: true, children: `${f.icon}  ${f.word}` }),
    Text({ children: `  ${now.percent}% of context` }),
    Text({ dimColor: true, children: `  ${short(now.tokens)} / ${short(now.window)}` }),
  ];
  const limitParts = rateLimitParts(Text);
  if (limitParts.length) {
    parts.push(Text({ dimColor: true, children: "  │" }));
    parts.push(...limitParts);
  }
  if (columns >= 90) {
    parts.push(Text({ dimColor: true, children: "   last turns " }));
    parts.push(Text({ color: f.color, children: chart() }));
    if (trend) {
      parts.push(Text({ dimColor: true, children: `  ${trend}` }));
    }
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
