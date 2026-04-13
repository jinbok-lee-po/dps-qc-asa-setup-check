/**
 * DPS 커머스 검증: 부모 탭과 iframe 조작 없이
 * chrome.tabs.create 로 전체 edit URL 을 연 뒤, 각 탭의 content script 가 폴링·STEP_DONE.
 */
const PORTAL_ORIGIN = "https://portal.woowahan.com";
const PORTAL_BASE_PATH = "/pv2/kr/p/logistics-dynamic-pricing";

function editUrlForExperiment(id) {
  return `${PORTAL_ORIGIN}${PORTAL_BASE_PATH}#/automatic-assignment/${id}/edit`;
}

function finishRun(state, sendResponse) {
  const final = {
    results: state.results,
    verticalSegment: state.verticalSegment,
  };
  chrome.storage.local.remove("dpsCommerceRunState", () => {
    chrome.storage.local.set({ dpsCommerceFinalResults: final }, () => {
      sendResponse({ ok: true });
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "DPS_COMMERCE_START_RUN") {
    const openerTabId = sender.tab?.id;
    const ids = message.ids;
    const verticalSegment = message.verticalSegment;
    if (!Array.isArray(ids) || ids.length === 0) {
      sendResponse({ ok: false, error: "ids 비어 있음" });
      return false;
    }
    void (async () => {
      try {
        await chrome.runtime.getPlatformInfo();
      } catch {
        /* SW 기동만 시도 */
      }
      const state = {
        ids,
        verticalSegment,
        index: 0,
        results: [],
        openerTabId: openerTabId ?? null,
      };
      chrome.storage.local.set({ dpsCommerceRunState: state }, () => {
        chrome.tabs.create({ url: editUrlForExperiment(ids[0]), active: true }, (tab) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            chrome.storage.local.remove("dpsCommerceRunState", () => {
              sendResponse({ ok: false, error: msg });
            });
            return;
          }
          sendResponse({ ok: true, tabId: tab?.id });
        });
      });
    })();
    return true;
  }

  if (message.type === "DPS_COMMERCE_STEP_DONE") {
    void (async () => {
      try {
        await chrome.runtime.getPlatformInfo();
      } catch {
        /* SW 기동만 시도 */
      }
      const payload = message.payload;
      chrome.storage.local.get("dpsCommerceRunState", (data) => {
      const state = data.dpsCommerceRunState;
      if (!state || !Array.isArray(state.ids)) {
        sendResponse({ ok: false, error: "no run state" });
        return;
      }
      if (payload?.ok) {
        state.results.push(payload.result);
      } else {
        state.results.push({
          experimentId: payload.experimentId,
          error: payload.error || "unknown error",
        });
      }
      state.index += 1;
      if (state.index >= state.ids.length) {
        finishRun(state, sendResponse);
        return;
      }
      const nextId = state.ids[state.index];
      chrome.storage.local.set({ dpsCommerceRunState: state }, () => {
        chrome.tabs.create({ url: editUrlForExperiment(nextId), active: true }, () => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            chrome.storage.local.set(
              {
                dpsCommerceFinalResults: {
                  results: state.results,
                  verticalSegment: state.verticalSegment,
                  runError: msg,
                },
              },
              () => {
                chrome.storage.local.remove("dpsCommerceRunState", () => {
                  sendResponse({ ok: false, error: msg });
                });
              }
            );
            return;
          }
          sendResponse({ ok: true });
        });
      });
    });
    })();
    return true;
  }

  return false;
});
