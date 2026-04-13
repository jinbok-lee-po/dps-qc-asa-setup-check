#!/usr/bin/env node
/**
 * chrome-cdp 로 포털 탭에서 plugin iframe 텍스트를 읽고 Vendor group filters 검증.
 *
 * 전제:
 * - Chrome 에서 chrome://inspect/#remote-debugging 원격 디버깅 ON
 * - logistics-dynamic-pricing (automatic-assignment) 탭이 이미 열려 있음
 * - Node 22+
 *
 * 사용:
 *   node scripts/run-vendor-group-cdp.mjs 461
 *   node scripts/run-vendor-group-cdp.mjs 461,462 --target 6BE827FA
 *   node scripts/run-vendor-group-cdp.mjs 483 --no-overlay   # stdout만 (오버레이 없음)
 *   node scripts/run-vendor-group-cdp.mjs 461 --vertical food  # 푸드 → restaurants 검증
 *
 * 환경변수: CHROME_CDP_SKILL (cdp.mjs 가 있는 스킬 루트)
 *   DPS_ZONES_NAV_SETTLE_MS, DPS_ZONES_POLL_MS, DPS_ZONES_MAX_MS — iframe 라우트·본문 폴링
 *   DPS_LIST_ROUTE_WAIT_MS, DPS_LIST_ROUTE_POLL_MS — eval 내 iframe 목록 해시 폴링(기본 10000 / 80)
 *   DPS_CDP_BETWEEN_MS — 실험 ID 바꿀 때 추가 대기(기본 700ms), 연속 CDP 시 UI 안정화
 *
 * 접속·리프레시 (익스텐션 content.js 와 맞춤):
 *   eval: 상단 history 를 먼저 목록(#/automatic-assignment)으로 맞춘 뒤 iframe 목록 replace,
 *   iframe location.hash 가 목록인지 폴링(최대 DPS_LIST_ROUTE_WAIT_MS), 실패 시 about:blank 후 재시도,
 *   그다음 상단 edit 맞춤 후 iframe 은 contentWindow.location.replace(edit) 만 (익스텐션 v0.5 과 동일).
 *   이후 fetchIframeTextForExperiment 가 Vendor group filters 가 보일 때까지 폴링.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  buildVendorGroupFiltersReportText,
  normalizeVerticalSegment,
  validateVendorGroupFilters,
} from "./vendor-group-filters-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const AUTOMATIC_ASSIGNMENT_HASH_PREFIX = "#/automatic-assignment";
const PORTAL_ORIGIN = "https://portal.woowahan.com";
const PORTAL_BASE_PATH = "/pv2/kr/p/logistics-dynamic-pricing";

/** 익스텐션: syncTop 목록 → iframe 목록 → 해시 폴링 → (폴백 about:blank) → syncTop+iframe edit */
function navLikeExtensionJs(experimentId) {
  const id = JSON.stringify(String(experimentId));
  const listWait = Number(process.env.DPS_LIST_ROUTE_WAIT_MS) || 10000;
  const listPoll = Number(process.env.DPS_LIST_ROUTE_POLL_MS) || 80;
  const stabilize = Number(process.env.DPS_LIST_STABILIZE_MS) || 120;
  return `(() => {
    const id = ${id};
    const ORIGIN = ${JSON.stringify(PORTAL_ORIGIN)};
    const BASE_PATH = ${JSON.stringify(PORTAL_BASE_PATH)};
    const listHash = "#/automatic-assignment";
    const editHash = "#/automatic-assignment/" + id + "/edit";
    const listWant = listHash.toLowerCase();
    const f = document.querySelector("iframe.pluginIframe");
    if (!f || !f.contentWindow) return JSON.stringify({ ok: false, error: "no iframe.pluginIframe" });
    function normHash(href) {
      try {
        const u = new URL(href);
        let h = (u.hash || "").split("?")[0];
        while (h.length > 1 && h.endsWith("/")) h = h.slice(0, -1);
        return (h || "").toLowerCase();
      } catch (e) {
        return "";
      }
    }
    function isListHref(href) {
      return normHash(href) === listWant;
    }
    function spin(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {}
    }
    function readIframeHref() {
      try {
        return (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || "";
      } catch (e) {
        return "";
      }
    }
    function waitListRoute() {
      const dl = Date.now() + ${listWait};
      while (Date.now() < dl) {
        if (isListHref(readIframeHref())) return true;
        spin(${listPoll});
      }
      return false;
    }
    try {
      const path = (window.location.pathname || "").split("?")[0];
      const topList = window.location.origin + path + listHash;
      const topEdit = window.location.origin + path + editHash;
      try {
        history.replaceState(null, "", topList);
      } catch (e1) {
        window.location.hash = listHash;
      }
      f.contentWindow.location.replace(ORIGIN + BASE_PATH + listHash);
      let ok = waitListRoute();
      if (!ok) {
        try {
          f.contentWindow.location.replace("about:blank");
          const bdl = Date.now() + 5000;
          while (Date.now() < bdl) {
            const bh = readIframeHref();
            if (bh.indexOf("about:blank") === 0) break;
            spin(50);
          }
        } catch (e2) {}
        try {
          history.replaceState(null, "", topList);
        } catch (e3) {
          window.location.hash = listHash;
        }
        f.contentWindow.location.replace(ORIGIN + BASE_PATH + listHash);
        ok = waitListRoute();
        if (!ok) {
          return JSON.stringify({
            ok: false,
            error: "iframe did not reach #/automatic-assignment (after about:blank reset)",
          });
        }
      }
      spin(${stabilize});
      try {
        history.replaceState(null, "", topEdit);
      } catch (e4) {
        window.location.hash = editHash;
      }
      f.contentWindow.location.replace(ORIGIN + BASE_PATH + editHash);
      return JSON.stringify({ ok: true });
    } catch (e) {
      return JSON.stringify({ ok: false, error: "nav: " + e });
    }
  })()`;
}

function resolveCdpRoot() {
  const env = process.env.CHROME_CDP_SKILL?.trim();
  if (env && existsSync(join(env, "scripts/cdp.mjs"))) return env;
  const local = join(PROJECT_ROOT, "chrome-cdp-skill/skills/chrome-cdp");
  if (existsSync(join(local, "scripts/cdp.mjs"))) return local;
  const cursor = join(homedir(), ".cursor/skills-cursor/chrome-cdp");
  if (existsSync(join(cursor, "scripts/cdp.mjs"))) return cursor;
  return null;
}

function runCdp(cdpRoot, args) {
  const cdp = join(cdpRoot, "scripts/cdp.mjs");
  const r = spawnSync(process.execPath, [cdp, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    throw new Error(msg);
  }
  return r.stdout;
}

function findPortalTargetPrefix(listStdout) {
  const lines = listStdout.split("\n").filter(Boolean);
  for (const line of lines) {
    if (line.includes("logistics-dynamic-pricing")) {
      const prefix = line.trim().split(/\s+/)[0];
      if (prefix && /^[0-9A-F]+$/i.test(prefix)) return prefix;
    }
  }
  return null;
}

function resolveTargetPrefix(cdpRoot, targetPrefix) {
  if (targetPrefix) return targetPrefix;
  let listOut;
  try {
    listOut = runCdp(cdpRoot, ["list"]);
  } catch (e) {
    console.error("cdp list 실패:", e.message);
    process.exit(1);
  }
  const found = findPortalTargetPrefix(listOut);
  if (!found) {
    console.error(
      "logistics-dynamic-pricing 탭을 list에서 찾지 못했습니다. 포털 탭을 연 뒤 다시 시도하거나 --target 으로 타겟 접두사를 지정하세요.\n\n--- list ---\n" +
        listOut
    );
    process.exit(1);
  }
  console.error(`(자동 선택 타겟 접두사: ${found})`);
  return found;
}

function extractIframeTextWhenRouteJs(expectedId) {
  const exp = JSON.stringify(String(expectedId));
  return `(() => {
    const expected = ${exp};
    const f = document.querySelector("iframe.pluginIframe");
    if (!f) return JSON.stringify({ ok: false, error: "no iframe.pluginIframe" });
    let href = "";
    try {
      href = (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || "";
    } catch (e) {
      return JSON.stringify({ ok: false, error: "cannot read iframe location: " + e });
    }
    const m = href.match(/automatic-assignment\\/(\\d+)\\/edit(?:[?#]|$)/i);
    const current = m ? m[1] : null;
    if (current !== expected) {
      return JSON.stringify({
        ok: false,
        error: "iframe route mismatch (current " + current + ", need " + expected + ")",
      });
    }
    let d;
    try {
      d = f.contentDocument;
    } catch (e) {
      return JSON.stringify({ ok: false, error: "cannot access iframe: " + e });
    }
    if (!d || !d.body) return JSON.stringify({ ok: false, error: "no iframe body" });
    const text = d.body.innerText || "";
    return JSON.stringify({ ok: true, text });
  })()`;
}

function parseIframeNavResult(evalOut) {
  const line = evalOut.trim().split("\n").pop() || evalOut.trim();
  const data = JSON.parse(line);
  if (!data.ok) throw new Error(data.error || "iframe navigation failed");
}

function parseEvalTextResult(evalOut) {
  const line = evalOut.trim().split("\n").pop() || evalOut.trim();
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    throw new Error(`eval 결과 JSON 파싱 실패:\n${evalOut}`);
  }
  if (!data.ok) throw new Error(data.error || "unknown error");
  return data.text || "";
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function fetchIframeTextForExperiment(cdpRoot, targetPrefix, experimentId) {
  const id = String(experimentId);
  const url = `${PORTAL_ORIGIN}${PORTAL_BASE_PATH}${AUTOMATIC_ASSIGNMENT_HASH_PREFIX}/${id}/edit`;
  runCdp(cdpRoot, ["nav", targetPrefix, url]);
  parseIframeNavResult(runCdp(cdpRoot, ["eval", targetPrefix, navLikeExtensionJs(id)]));
  const settleMs = Number(process.env.DPS_ZONES_NAV_SETTLE_MS) || 400;
  const pollMs = Number(process.env.DPS_ZONES_POLL_MS) || 600;
  const maxMs = Number(process.env.DPS_ZONES_MAX_MS) || 45000;
  const vendorMark = /vendor\s*group\s*filters/i;
  sleepSync(settleMs);
  const deadline = Date.now() + maxMs;
  let lastErr = "timeout waiting for iframe route + body + Vendor group filters";
  while (Date.now() < deadline) {
    try {
      const evalOut = runCdp(cdpRoot, ["eval", targetPrefix, extractIframeTextWhenRouteJs(id)]);
      const text = parseEvalTextResult(evalOut);
      if (!vendorMark.test(text)) {
        lastErr = "iframe innerText 에 아직 Vendor group filters 없음 (로딩 대기)";
        sleepSync(pollMs);
        continue;
      }
      return text;
    } catch (e) {
      lastErr = e.message || String(e);
      sleepSync(pollMs);
    }
  }
  throw new Error(lastErr);
}

function buildReportOverlayEval(reportText) {
  const t = JSON.stringify(reportText);
  return `(() => {
    const text = ${t};
    const id = "dps-cdp-vendor-report-overlay";
    document.getElementById(id)?.remove();
    const backdrop = document.createElement("div");
    backdrop.id = id;
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-label", "DPS Vendor group filters CDP 결과");
    Object.assign(backdrop.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      background: "rgba(0,0,0,0.35)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif',
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "#fff",
      borderRadius: "12px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
      maxWidth: "min(720px, 100%)",
      maxHeight: "min(88vh, 920px)",
      width: "100%",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    });
    const hdr = document.createElement("div");
    Object.assign(hdr.style, {
      flexShrink: "0",
      padding: "12px 16px",
      borderBottom: "1px solid #e8e8e8",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
      fontWeight: "700",
      fontSize: "15px",
    });
    const title = document.createElement("span");
    title.textContent = "Vendor group filters 검증 결과 (CDP)";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "닫기";
    Object.assign(closeBtn.style, {
      border: "none",
      background: "#f1f3f5",
      padding: "8px 14px",
      borderRadius: "8px",
      cursor: "pointer",
      fontWeight: "600",
      fontSize: "13px",
    });
    const pre = document.createElement("pre");
    pre.textContent = text;
    Object.assign(pre.style, {
      margin: "0",
      padding: "14px 16px",
      overflow: "auto",
      flex: "1",
      minHeight: "0",
      fontSize: "12px",
      lineHeight: "1.45",
      whiteSpace: "pre-wrap",
      wordBreak: "break-word",
    });
    function dismiss() {
      backdrop.remove();
    }
    closeBtn.addEventListener("click", dismiss);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) dismiss();
    });
    hdr.appendChild(title);
    hdr.appendChild(closeBtn);
    box.appendChild(hdr);
    box.appendChild(pre);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    return JSON.stringify({ ok: true });
  })()`;
}

function showReportOverlayInPortalTab(cdpRoot, targetPrefix, reportText) {
  const out = runCdp(cdpRoot, ["eval", targetPrefix, buildReportOverlayEval(reportText)]);
  const line = out.trim().split("\n").pop() || out.trim();
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    throw new Error(`오버레이 eval 파싱 실패:\n${out}`);
  }
  if (!data.ok) throw new Error(data.error || "overlay failed");
}

function parseArgs(argv) {
  const ids = [];
  let targetPrefix = "";
  let noOverlay = false;
  let verticalRaw = "bmart";
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--target") {
      targetPrefix = rest[i + 1] || "";
      i++;
      continue;
    }
    if (rest[i] === "--vertical") {
      verticalRaw = rest[i + 1] || "bmart";
      i++;
      continue;
    }
    if (rest[i] === "--no-overlay") {
      noOverlay = true;
      continue;
    }
    if (rest[i].startsWith("--")) continue;
    for (const part of rest[i].split(",").map((s) => s.trim()).filter(Boolean)) {
      const n = Number(part);
      if (!Number.isInteger(n) || n < 1) throw new Error(`잘못된 실험 ID: ${part}`);
      ids.push(n);
    }
  }
  if (ids.length === 0) throw new Error("실험 ID를 인자로 주세요. 예: node scripts/run-vendor-group-cdp.mjs 461");
  const verticalSegment = normalizeVerticalSegment(verticalRaw);
  return {
    ids: [...new Set(ids)].sort((a, b) => a - b),
    targetPrefix,
    noOverlay,
    verticalSegment,
  };
}

function main() {
  const cdpRoot = resolveCdpRoot();
  if (!cdpRoot) {
    console.error(
      "chrome-cdp 스킬을 찾을 수 없습니다. CHROME_CDP_SKILL 설정, 프로젝트에 chrome-cdp-skill 클론, 또는 ~/.cursor/skills-cursor/chrome-cdp 를 준비하세요."
    );
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  const targetPrefix = resolveTargetPrefix(cdpRoot, parsed.targetPrefix);
  console.error(
    `(Vertical 구분: ${parsed.verticalSegment === "food" ? "푸드 → restaurants" : "커머스 → shop"})`
  );

  /** @type {object[]} */
  const results = [];
  const betweenMs = Number(process.env.DPS_CDP_BETWEEN_MS) || 700;
  for (let i = 0; i < parsed.ids.length; i++) {
    const experimentId = parsed.ids[i];
    if (i > 0) sleepSync(betweenMs);
    console.error(`\n--- 실험 ${experimentId} (CDP) ---`);
    try {
      const text = fetchIframeTextForExperiment(cdpRoot, targetPrefix, experimentId);
      const v = validateVendorGroupFilters(text, {
        verticalSegment: parsed.verticalSegment,
      });
      results.push({
        experimentId,
        ok: v.ok,
        detail: v.detail,
        checks: v.checks,
      });
      if (!v.ok) process.exitCode = 1;
    } catch (e) {
      results.push({ experimentId, error: String(e.message || e) });
      process.exitCode = 1;
    }
  }
  const reportText = buildVendorGroupFiltersReportText(results, {
    verticalSegment: parsed.verticalSegment,
  });
  console.log(reportText);

  const skipOverlay =
    parsed.noOverlay || String(process.env.DPS_CDP_REPORT_OVERLAY || "").trim() === "0";
  if (!skipOverlay) {
    try {
      showReportOverlayInPortalTab(cdpRoot, targetPrefix, reportText);
      console.error("(포털 탭에 결과 리포트 오버레이를 표시했습니다. 닫기 또는 바깥 영역 클릭으로 닫을 수 있습니다.)");
    } catch (e) {
      console.error("(오버레이 표시 실패 — 터미널 stdout 리포트를 사용하세요):", e.message || e);
    }
  }
}

main();
