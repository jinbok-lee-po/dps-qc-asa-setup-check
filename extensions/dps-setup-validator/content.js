(() => {
  const VERSION = "0.1.0";
  const BASE_PATH = "/pv2/kr/p/logistics-dynamic-pricing";
  const ORIGIN = "https://portal.woowahan.com";
  /** 실행창·FAB 노출: automatic-assignment 및 하위 (쿼리 제외, 끝 슬래시 정규화) */
  const COMMERCE_HASH_PREFIX = "#/automatic-assignment";

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
        <p class="dps-placeholder">검수 항목은 아직 정의되지 않았습니다. 이후 버전에서 추가할 예정입니다.</p>
      </div>
    `;

    const closeBtn = panel.querySelector(".dps-close");

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
      closeBtn.focus();
    }

    function closePanel() {
      panelWrap.classList.remove("dps-open");
    }

    fab.addEventListener("click", openPanel);
    closeBtn.addEventListener("click", closePanel);

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
