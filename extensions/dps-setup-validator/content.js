(() => {
  const VERSION = "0.3.3";
  const POLL_MS = 600;
  const MAX_MS = 45000;
  const NAV_SETTLE_MS = 400;
  const BASE_PATH = "/pv2/kr/p/logistics-dynamic-pricing";
  const ORIGIN = "https://portal.woowahan.com";
  const COMMERCE_HASH_PREFIX = "#/automatic-assignment";

  /** 검증 규칙은 scripts/vendor-group-filters-logic.mjs 와 동기화 */
  const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
  const VERTICAL_TYPE_IS_SHOP = /vertical\s*type[\s\S]{0,500}?\bis\b[\s\S]{0,240}?\bshop\b/i;
  const DELIVERY_TYPES_LABEL = /delivery\s+types?\b/i;
  const PLATFORM_DELIVERY_VALUE = /\bPLATFORM[\s_-]+DELIVERY\b/i;
  const NEXT_FILTER_AFTER_VALUE = /\n\s*(?:Delivery types?|Vertical type|Vendor ids|Add filter)\b/i;

  function extractValuesBlockContents(section) {
    const blocks = [];
    let searchFrom = 0;
    while (searchFrom < section.length) {
      const sub = section.slice(searchFrom);
      const mOpen = sub.match(/\bValues\b/i);
      if (!mOpen) break;
      const afterOpen = searchFrom + mOpen.index + mOpen[0].length;
      const sub2 = section.slice(afterOpen);
      const mClose = sub2.match(/\bValues\b/i);
      if (!mClose) break;
      const inner = section.slice(afterOpen, afterOpen + mClose.index).trim();
      blocks.push(inner);
      searchFrom = afterOpen + mClose.index + mClose[0].length;
    }
    return blocks;
  }

  function tokensInBlock(inner) {
    return inner
      .split(/\n/)
      .flatMap((line) => line.split(","))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function vendorIdsFromClauseValuesBlocks(blocks) {
    for (const inner of blocks) {
      const tokens = tokensInBlock(inner);
      if (tokens.length === 0) continue;
      if (tokens.every((t) => /^\d+$/.test(t))) {
        return {
          ok: true,
          count: tokens.length,
          ids: tokens,
          detail: `Clause/Values UI — vendor id ${tokens.length}개: ${tokens.join(", ")}`,
        };
      }
    }
    return null;
  }

  function verticalShopFromClauseValuesBlocks(blocks) {
    return blocks.some((inner) => /^shop$/i.test(inner.trim()));
  }

  function platformDeliveryFromClauseValuesBlocks(blocks) {
    return blocks.some((inner) => /^PLATFORM[\s_-]+DELIVERY$/i.test(inner.trim()));
  }

  function checkDeliveryTypesPlatform(section) {
    const labelM = section.match(DELIVERY_TYPES_LABEL);
    if (!labelM || labelM.index == null) {
      return {
        ok: false,
        detail:
          'Vendor group filters 이후 "Delivery type" / "Delivery types" 라벨을 찾지 못했습니다.',
      };
    }
    const fromLabel = section.slice(labelM.index);
    const valueM = fromLabel.match(PLATFORM_DELIVERY_VALUE);
    if (!valueM || valueM.index == null) {
      return {
        ok: false,
        detail:
          'Delivery types 근처에서 PLATFORM_DELIVERY(또는 PLATFORM DELIVERY / PLATFORM-DELIVERY) 값을 찾지 못했습니다.',
      };
    }
    const betweenLabelAndValue = fromLabel.slice(labelM[0].length, valueM.index);
    if (!/\bis\b/i.test(betweenLabelAndValue)) {
      return {
        ok: false,
        detail:
          'Delivery types 와 PLATFORM_DELIVERY 사이에 연산자 "is"가 없습니다.',
      };
    }
    return {
      ok: true,
      detail: `Delivery types is ${valueM[0].trim()} 확인됨.`,
    };
  }

  function sliceVendorGroupFiltersSection(fullText) {
    const t = fullText || "";
    const m = t.match(VENDOR_GROUP_MARK);
    if (!m || m.index == null) return null;
    return t.slice(m.index);
  }

  /**
   * "Vendor ids" … "is" 직후부터 다음 필터 라벨 전까지 잘라 셈한다.
   * 쉼표·줄바꿈으로 구분된 비어 있지 않은 토큰 수 = vendor id 그룹(항목) 개수로 본다.
   */
  function parseVendorIdsCountAfterIs(fromVendorGroupFilters) {
    const re = /vendor\s*ids[\s\S]{0,400}?\bis\b/i;
    const m = fromVendorGroupFilters.match(re);
    if (!m || m.index == null) {
      return {
        ok: false,
        count: null,
        ids: null,
        detail: '"Vendor ids" · "is" 패턴을 찾지 못했습니다.',
      };
    }
    const afterIs = fromVendorGroupFilters.slice(m.index + m[0].length);
    const stop = afterIs.search(NEXT_FILTER_AFTER_VALUE);
    const raw = (stop === -1 ? afterIs : afterIs.slice(0, stop)).trim();
    if (!raw) {
      return {
        ok: true,
        count: 0,
        ids: [],
        detail: "Vendor ids is 다음에 값이 없습니다 (0개).",
      };
    }
    const parts = raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      ok: true,
      count: parts.length,
      ids: parts,
      detail: `Vendor ids is 다음 vendor id(그룹) 개수: ${parts.length}개: ${parts.join(", ")}`,
    };
  }

  /**
   * Vendor group filters 이하 텍스트에 대한 검증 묶음.
   */
  function validateVendorGroupFilters(iframeText) {
    const t = iframeText || "";
    if (!t.trim()) {
      return {
        ok: false,
        checks: null,
        detail: "iframe 본문 텍스트가 비어 있습니다.",
      };
    }
    const section = sliceVendorGroupFiltersSection(t);
    if (!section) {
      return {
        ok: false,
        checks: null,
        detail: '화면에 "Vendor group filters" 문구가 없습니다.',
      };
    }

    const blocks = extractValuesBlockContents(section);
    const viaVendor = vendorIdsFromClauseValuesBlocks(blocks);
    const vendorIds = viaVendor || parseVendorIdsCountAfterIs(section);

    const verticalFromBlocks = verticalShopFromClauseValuesBlocks(blocks);
    const verticalOk = verticalFromBlocks || VERTICAL_TYPE_IS_SHOP.test(section);
    const verticalDetail = verticalFromBlocks
      ? "Clause/Values UI — shop 확인됨."
      : verticalOk
        ? "Vertical type is shop 확인됨."
        : 'Vendor group filters 이후 shop(Vertical) 또는 "Vertical type" · "is" · "shop" 조합을 찾지 못했습니다.';

    const platformFromBlocks = platformDeliveryFromClauseValuesBlocks(blocks);
    const deliveryLegacy = checkDeliveryTypesPlatform(section);
    const deliveryOk = platformFromBlocks || deliveryLegacy.ok;
    let deliveryDetail;
    if (platformFromBlocks) {
      deliveryDetail = "Clause/Values UI — PLATFORM_DELIVERY 확인됨.";
    } else if (deliveryLegacy.ok) {
      deliveryDetail = deliveryLegacy.detail;
    } else if (blocks.length >= 2) {
      deliveryDetail =
        "Clause/Values 블록에 PLATFORM_DELIVERY가 없고, 레거시 Delivery types 라벨 패턴도 없습니다.";
    } else {
      deliveryDetail = deliveryLegacy.detail;
    }

    const ok = verticalOk && vendorIds.ok && deliveryOk;
    const checks = {
      verticalTypeShop: { ok: verticalOk, detail: verticalDetail },
      vendorIds: {
        ok: vendorIds.ok,
        count: vendorIds.count,
        ids: vendorIds.ids,
        detail: vendorIds.detail,
      },
      deliveryTypesPlatform: { ok: deliveryOk, detail: deliveryDetail },
    };

    const detail = [
      checks.verticalTypeShop.detail,
      checks.vendorIds.detail,
      checks.deliveryTypesPlatform.detail,
    ].join(" | ");

    return { ok, checks, detail };
  }

  function normalizedHash() {
    const raw = (window.location.hash || "").split("?")[0];
    return (raw.replace(/\/$/, "") || "").toLowerCase();
  }

  function isCommerceExperimentsRoute() {
    if (window.location.hostname !== "portal.woowahan.com") return false;
    const path = (window.location.pathname || "").replace(/\/$/, "") || "/";
    const baseNorm = BASE_PATH.replace(/\/$/, "") || "/";
    const onDps =
      path === baseNorm ||
      path.endsWith("/logistics-dynamic-pricing") ||
      path.includes("/logistics-dynamic-pricing/");
    if (!onDps) return false;
    const h = normalizedHash();
    const p = COMMERCE_HASH_PREFIX.toLowerCase();
    return h === p || h.startsWith(`${p}/`);
  }

  function parseIdInput(str) {
    const ids = [];
    for (const raw of str.split(",").map((s) => s.trim()).filter(Boolean)) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`잘못된 실험 ID: "${raw}" (양의 정수만, 쉼표로 구분)`);
      }
      ids.push(n);
    }
    if (ids.length === 0) throw new Error("실험 ID를 하나 이상 입력하세요.");
    return [...new Set(ids)].sort((a, b) => a - b);
  }

  function readIframeBodyText() {
    const f = document.querySelector("iframe.pluginIframe");
    if (!f) return { ok: false, error: "no iframe.pluginIframe" };
    let d;
    try {
      d = f.contentDocument;
    } catch (e) {
      return { ok: false, error: `cannot access iframe: ${e}` };
    }
    if (!d || !d.body) return { ok: false, error: "no iframe body" };
    return { ok: true, text: d.body.innerText || "" };
  }

  function getIframeRouteExperimentId() {
    const f = document.querySelector("iframe.pluginIframe");
    if (!f?.contentWindow) return null;
    let href = "";
    try {
      href = f.contentWindow.location.href || "";
    } catch {
      return null;
    }
    const m = href.match(/automatic-assignment\/(\d+)\/edit(?:[?#]|$)/i);
    return m ? m[1] : null;
  }

  function iframeShowsExperiment(experimentId) {
    return getIframeRouteExperimentId() === String(experimentId);
  }

  function navIframeToEdit(experimentId) {
    const id = String(experimentId);
    const hash = `#/automatic-assignment/${id}/edit`;
    const f = document.querySelector("iframe.pluginIframe");
    if (!f || !f.contentWindow) return { ok: false, error: "no iframe.pluginIframe" };
    try {
      f.contentWindow.location.replace(`${ORIGIN}${BASE_PATH}${hash}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `iframe nav: ${e}` };
    }
  }

  function syncTopLocationToEdit(experimentId) {
    const id = String(experimentId);
    const hash = `#/automatic-assignment/${id}/edit`;
    const path = window.location.pathname.split("?")[0];
    const next = `${window.location.origin}${path}${hash}`;
    try {
      history.replaceState(null, "", next);
    } catch {
      window.location.hash = hash;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function runVendorGroupFiltersCheckForExperiment(experimentId) {
    const id = String(experimentId);
    syncTopLocationToEdit(id);
    const navR = navIframeToEdit(id);
    if (!navR.ok) throw new Error(navR.error);

    await sleep(NAV_SETTLE_MS);

    const deadline = Date.now() + MAX_MS;
    let lastErr = "timeout waiting for target experiment in iframe";
    while (Date.now() < deadline) {
      if (!iframeShowsExperiment(experimentId)) {
        const cur = getIframeRouteExperimentId();
        lastErr =
          cur == null
            ? "iframe route not on experiment edit yet"
            : `iframe still on experiment ${cur}, waiting for ${id}`;
        await sleep(POLL_MS);
        continue;
      }
      const body = readIframeBodyText();
      if (!body.ok) {
        lastErr = body.error || lastErr;
        await sleep(POLL_MS);
        continue;
      }
      const v = validateVendorGroupFilters(body.text);
      return {
        experimentId,
        ok: v.ok,
        detail: v.detail,
        checks: v.checks,
      };
    }
    throw new Error(lastErr);
  }

  async function runBatch(ids) {
    /** @type {object[]} */
    const out = [];
    for (const experimentId of ids) {
      try {
        out.push(await runVendorGroupFiltersCheckForExperiment(experimentId));
      } catch (e) {
        out.push({ experimentId, error: String(e.message || e) });
      }
    }
    return out;
  }

  function verticalReportValue(verticalCheck) {
    if (!verticalCheck.ok) return verticalCheck.detail || "NG";
    const d = verticalCheck.detail || "";
    if (/restaurant/i.test(d)) return "restaurant";
    if (/shop/i.test(d)) return "shop";
    return "OK";
  }

  /** scripts/vendor-group-filters-logic.mjs `buildVendorGroupFiltersReportText` 와 동일 (동기화 필수) */
  function buildReportText(results) {
    const lines = [];
    lines.push("=== 검증 항목 ===");
    lines.push("(1) Vertical 설정이 올바르게 되어있는지 (Bmart: shop, Food: restaurant)");
    lines.push("(2) delivery type이 OD(PLATFORM_DELIVERY)로 설정되어 있는지");
    lines.push("(3) ASA ID별 vendor id 개수·목록");
    lines.push("");
    for (const r of results) {
      if (r.error) {
        lines.push(`실험 ID: ${r.experimentId} - 수집 실패`);
        lines.push(`  ${r.error}`);
        lines.push("");
        continue;
      }
      const statusLabel = r.ok ? "정상" : "불통과";
      lines.push(`실험 ID: ${r.experimentId} - ${statusLabel}`);
      if (r.checks) {
        const c = r.checks;
        const vMark = c.verticalTypeShop.ok ? "OK" : "NG";
        lines.push(`(1) Vertical\t${vMark}\t${verticalReportValue(c.verticalTypeShop)}`);
        const dMark = c.deliveryTypesPlatform.ok ? "OK" : "NG";
        const dVal = c.deliveryTypesPlatform.ok
          ? "PLATFORM_DELIVERY"
          : c.deliveryTypesPlatform.detail;
        lines.push(`(2) delivery\t${dMark}\t${dVal}`);
        const vid = c.vendorIds;
        if (vid.ok) {
          const n = vid.count != null ? vid.count : vid.ids?.length ?? 0;
          const listStr =
            vid.ids == null
              ? "(미수집)"
              : vid.ids.length === 0
                ? "(없음)"
                : vid.ids.join(", ");
          lines.push(`(3) Vendor id\t${n}개\t${listStr}`);
        } else {
          lines.push(`(3) Vendor id\tNG\t${vid.detail}`);
        }
      }
      lines.push("");
    }
    const pass = results.filter((x) => x.ok === true).length;
    const failRule = results.filter((x) => x.ok === false && !x.error).length;
    const failTech = results.filter((x) => x.error).length;
    lines.push(
      `요약: 통과 ${pass} · 규칙 불통과 ${failRule} · 수집 실패 ${failTech} (총 ${results.length}건)`
    );
    lines.push("");
    lines.push(JSON.stringify({ results, summary: { pass, failRule, failTech, total: results.length } }, null, 2));
    return lines.join("\n");
  }

  function ensureRoot() {
    if (document.getElementById("dps-commerce-validator-root")) return;

    const root = document.createElement("div");
    root.id = "dps-commerce-validator-root";

    const fab = document.createElement("button");
    fab.id = "dps-commerce-validator-fab";
    fab.type = "button";
    fab.textContent = "DPS 커머스 운영안 검증";
    fab.title = `DPS 커머스 운영안 검증 v${VERSION}`;

    const panelWrap = document.createElement("div");
    panelWrap.id = "dps-commerce-validator-panel-wrap";
    panelWrap.setAttribute("role", "dialog");
    panelWrap.setAttribute("aria-label", "DPS 커머스 운영안 검증");

    const panel = document.createElement("div");
    panel.id = "dps-commerce-validator-panel";

    panel.innerHTML = `
      <header>
        <h1>DPS 커머스 운영안 검증 <span style="font-weight:500;color:#6c757d;font-size:13px">v${VERSION}</span></h1>
        <button type="button" class="dps-close" aria-label="닫기">×</button>
      </header>
      <div class="dps-body">
        <label class="dps-label" for="dps-commerce-ids-input">실험 ID (쉼표로 구분)</label>
        <textarea id="dps-commerce-ids-input" placeholder="예: 141, 142" spellcheck="false"></textarea>
        <div class="dps-meta">
          <strong>검증 항목 (Vendor Group Filters, iframe innerText)</strong>
          <ul>
            <li><strong>Clause/Values UI</strong>: 첫 숫자-only <code>Values</code> 블록 → vendor id <strong>개수·목록</strong> (리포트에 쉼표 구분)</li>
            <li>어느 <code>Values</code> 블록이든 내용이 <strong>shop</strong> 이면 Vertical 통과</li>
            <li><strong>PLATFORM_DELIVERY</strong> 블록이 있으면 Delivery 통과 (레거시 영문 라벨 UI도 지원)</li>
          </ul>
        </div>
        <div class="dps-actions">
          <button type="button" id="dps-commerce-run">실행</button>
        </div>
        <div id="dps-commerce-complete-banner" class="dps-complete">검증이 완료되었습니다.</div>
        <div id="dps-commerce-results"></div>
      </div>
    `;

    const closeBtn = panel.querySelector(".dps-close");
    const runBtn = panel.querySelector("#dps-commerce-run");
    const input = panel.querySelector("#dps-commerce-ids-input");
    const resultsEl = panel.querySelector("#dps-commerce-results");
    const completeBanner = panel.querySelector("#dps-commerce-complete-banner");

    function openPanel() {
      if (!isCommerceExperimentsRoute()) {
        alert(
          "DPS 커머스 운영안 화면에서만 사용할 수 있습니다.\n\n" +
            `예: ${ORIGIN}${BASE_PATH}${COMMERCE_HASH_PREFIX}\n` +
            `또는 ${ORIGIN}${BASE_PATH}#/automatic-assignment/… (하위 경로 포함)`
        );
        return;
      }
      panelWrap.classList.add("dps-open");
      input.focus();
    }

    function closePanel() {
      panelWrap.classList.remove("dps-open");
    }

    fab.addEventListener("click", openPanel);
    closeBtn.addEventListener("click", closePanel);

    runBtn.addEventListener("click", async () => {
      resultsEl.classList.remove("dps-visible");
      resultsEl.textContent = "";
      completeBanner.classList.remove("dps-visible");
      const oldErr = panel.querySelector(".dps-err");
      if (oldErr) oldErr.remove();

      let ids;
      try {
        ids = parseIdInput(input.value);
      } catch (e) {
        const p = document.createElement("p");
        p.className = "dps-err";
        p.textContent = String(e.message || e);
        panel.querySelector(".dps-actions").after(p);
        return;
      }

      runBtn.disabled = true;
      runBtn.textContent = "실행 중…";
      let succeeded = false;
      try {
        const batchResults = await runBatch(ids);
        const pre = document.createElement("pre");
        pre.textContent = buildReportText(batchResults);
        resultsEl.appendChild(pre);
        resultsEl.classList.add("dps-visible");
        succeeded = true;
      } catch (e) {
        const p = document.createElement("p");
        p.className = "dps-err";
        p.textContent = String(e.message || e);
        panel.querySelector(".dps-actions").after(p);
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = "실행";
        if (succeeded) completeBanner.classList.add("dps-visible");
        syncFabVisibility();
      }
    });

    panelWrap.appendChild(panel);
    root.appendChild(fab);
    root.appendChild(panelWrap);
    document.documentElement.appendChild(root);

    function syncFabVisibility() {
      fab.style.display = isCommerceExperimentsRoute() ? "block" : "none";
    }

    function onUserNavigation() {
      syncFabVisibility();
      if (!isCommerceExperimentsRoute() && panelWrap.classList.contains("dps-open")) closePanel();
    }

    syncFabVisibility();
    window.addEventListener("hashchange", onUserNavigation);
    window.addEventListener("popstate", onUserNavigation);

    function hookHistoryForFabSync() {
      const notify = () => queueMicrotask(() => syncFabVisibility());
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function (...args) {
        const ret = origPush.apply(history, args);
        notify();
        return ret;
      };
      history.replaceState = function (...args) {
        const ret = origReplace.apply(history, args);
        notify();
        return ret;
      };
    }
    hookHistoryForFabSync();

    setInterval(syncFabVisibility, 400);
    setTimeout(syncFabVisibility, 50);
    setTimeout(syncFabVisibility, 500);
    setTimeout(syncFabVisibility, 2000);
  }

  ensureRoot();
})();
