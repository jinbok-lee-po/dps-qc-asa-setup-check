(() => {
  const VERSION = "0.2.0";
  const POLL_MS = 600;
  const MAX_MS = 45000;
  const NAV_SETTLE_MS = 400;
  const BASE_PATH = "/pv2/kr/p/logistics-dynamic-pricing";
  const ORIGIN = "https://portal.woowahan.com";
  const COMMERCE_HASH_PREFIX = "#/automatic-assignment";

  /**
   * Vendor group filters 영역에서 Vertical type · is · shop 이 한 필터로 이어지는지 본다.
   * (iframe innerText 기준, 대소문자 무시. shop 은 단어 단위로만 매칭)
   */
  const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
  const VERTICAL_TYPE_IS_SHOP = /vertical\s*type[\s\S]{0,500}?\bis\b[\s\S]{0,240}?\bshop\b/i;

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

  function validateVendorGroupVerticalTypeShop(iframeText) {
    const t = iframeText || "";
    if (!t.trim()) {
      return { ok: false, detail: "iframe 본문 텍스트가 비어 있습니다." };
    }
    const m = t.match(VENDOR_GROUP_MARK);
    if (!m || m.index == null) {
      return {
        ok: false,
        detail: '화면에 "Vendor group filters" 문구가 없습니다.',
      };
    }
    const fromMark = t.slice(m.index);
    if (!VERTICAL_TYPE_IS_SHOP.test(fromMark)) {
      return {
        ok: false,
        detail:
          'Vendor group filters 이후 텍스트에서 "Vertical type" · "is" · "shop" 조합을 찾지 못했습니다. (연산자는 is, 값은 shop 단어)',
      };
    }
    return { ok: true, detail: "Vertical type is shop 확인됨." };
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

  async function runVerticalTypeCheckForExperiment(experimentId) {
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
      const v = validateVendorGroupVerticalTypeShop(body.text);
      return { experimentId, ok: v.ok, detail: v.detail };
    }
    throw new Error(lastErr);
  }

  async function runBatch(ids) {
    /** @type {{ experimentId: number, ok?: boolean, detail?: string, error?: string }[]} */
    const out = [];
    for (const experimentId of ids) {
      try {
        out.push(await runVerticalTypeCheckForExperiment(experimentId));
      } catch (e) {
        out.push({ experimentId, error: String(e.message || e) });
      }
    }
    return out;
  }

  function buildReportText(results) {
    const lines = [];
    lines.push("=== Vendor group filters: Vertical type is shop ===");
    lines.push("");
    for (const r of results) {
      if (r.error) {
        lines.push(`${r.experimentId}\t실패: ${r.error}`);
      } else if (r.ok) {
        lines.push(`${r.experimentId}\t통과\t${r.detail}`);
      } else {
        lines.push(`${r.experimentId}\t불통과\t${r.detail}`);
      }
    }
    const pass = results.filter((x) => x.ok === true).length;
    const failRule = results.filter((x) => x.ok === false && !x.error).length;
    const failTech = results.filter((x) => x.error).length;
    lines.push("");
    lines.push(`요약: 통과 ${pass} · 규칙 불통과 ${failRule} · 수집 실패 ${failTech} (총 ${results.length}건)`);
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
          <strong>검증 항목</strong>
          <ul>
            <li><strong>Vendor group filters</strong>에서 <strong>Vertical type</strong> · <strong>is</strong> · <strong>shop</strong> (iframe에 보이는 텍스트 기준)</li>
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
