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
 *
 * 환경변수: CHROME_CDP_SKILL (cdp.mjs 가 있는 스킬 루트), DPS_ZONES_* 폴링 옵션
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { validateVendorGroupFilters } from "./vendor-group-filters-logic.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const AUTOMATIC_ASSIGNMENT_HASH_PREFIX = "#/automatic-assignment";

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

function navPluginIframeToEditJs(experimentId) {
  const hash = `${AUTOMATIC_ASSIGNMENT_HASH_PREFIX}/${experimentId}/edit`;
  return `(() => {
    const base = "https://portal.woowahan.com/pv2/kr/p/logistics-dynamic-pricing";
    const hash = ${JSON.stringify(hash)};
    const f = document.querySelector("iframe.pluginIframe");
    if (!f || !f.contentWindow) return JSON.stringify({ ok: false, error: "no iframe.pluginIframe" });
    try {
      f.contentWindow.location.replace(base + hash);
      return JSON.stringify({ ok: true });
    } catch (e) {
      return JSON.stringify({ ok: false, error: "iframe nav: " + e });
    }
  })()`;
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
  const url = `https://portal.woowahan.com/pv2/kr/p/logistics-dynamic-pricing${AUTOMATIC_ASSIGNMENT_HASH_PREFIX}/${id}/edit`;
  runCdp(cdpRoot, ["nav", targetPrefix, url]);
  parseIframeNavResult(runCdp(cdpRoot, ["eval", targetPrefix, navPluginIframeToEditJs(id)]));
  const settleMs = Number(process.env.DPS_ZONES_NAV_SETTLE_MS) || 400;
  const pollMs = Number(process.env.DPS_ZONES_POLL_MS) || 600;
  const maxMs = Number(process.env.DPS_ZONES_MAX_MS) || 45000;
  sleepSync(settleMs);
  const deadline = Date.now() + maxMs;
  let lastErr = "timeout waiting for iframe route + body text";
  while (Date.now() < deadline) {
    try {
      const evalOut = runCdp(cdpRoot, ["eval", targetPrefix, extractIframeTextWhenRouteJs(id)]);
      return parseEvalTextResult(evalOut);
    } catch (e) {
      lastErr = e.message || String(e);
      sleepSync(pollMs);
    }
  }
  throw new Error(lastErr);
}

function parseArgs(argv) {
  const ids = [];
  let targetPrefix = "";
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--target") {
      targetPrefix = rest[i + 1] || "";
      i++;
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
  return { ids: [...new Set(ids)].sort((a, b) => a - b), targetPrefix };
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

  for (const experimentId of parsed.ids) {
    console.error(`\n--- 실험 ${experimentId} (CDP) ---`);
    try {
      const text = fetchIframeTextForExperiment(cdpRoot, targetPrefix, experimentId);
      const v = validateVendorGroupFilters(text);
      console.log(JSON.stringify({ experimentId, ...v }, null, 2));
      if (!v.ok) process.exitCode = 1;
    } catch (e) {
      console.log(JSON.stringify({ experimentId, ok: false, error: String(e.message || e) }, null, 2));
      process.exitCode = 1;
    }
  }
}

main();
