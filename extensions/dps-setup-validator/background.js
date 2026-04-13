/**
 * DPS 커머스 검증: 부모 탭과 iframe 조작 없이
 * 첫 실험은 chrome.tabs.create(active:false), 이후 동일 worker 탭에 chrome.tabs.update 로 edit URL 만 전환.
 * worker 탭은 포그라운드로 전환하지 않음(사용자는 실행을 누른 탭에 그대로).
 * (탭이 닫혔으면 create 로 복구·workerTabId 갱신) content script 가 폴링·STEP_DONE.
 */
const PORTAL_ORIGIN = "https://portal.woowahan.com";
const PORTAL_BASE_PATH = "/pv2/kr/p/logistics-dynamic-pricing";

function editUrlForExperiment(id) {
  return `${PORTAL_ORIGIN}${PORTAL_BASE_PATH}#/automatic-assignment/${id}/edit`;
}

/** tabs.update 직후 hashchange 가 없거나 늦을 때 content 가 자동 검증을 이어가도록 */
function pingWorkerContentScript(tabId, experimentId, attempt = 0) {
  if (tabId == null || experimentId == null) return;
  const id = Number(experimentId);
  if (!Number.isFinite(id)) return;
  chrome.tabs.sendMessage(tabId, { type: "DPS_COMMERCE_WORKER_NAV", experimentId: id }, () => {
    if (chrome.runtime.lastError && attempt < 12) {
      setTimeout(() => pingWorkerContentScript(tabId, experimentId, attempt + 1), 200);
    }
  });
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

function persistWorkerTabIdAndRespond(tabId, sendResponse, ok, pingExperimentId) {
  chrome.storage.local.get("dpsCommerceRunState", (d) => {
    const s = d.dpsCommerceRunState;
    if (s && Array.isArray(s.ids)) {
      s.workerTabId = tabId ?? s.workerTabId;
      chrome.storage.local.set({ dpsCommerceRunState: s }, () => {
        if (ok) sendResponse({ ok: true, tabId });
        if (pingExperimentId != null) pingWorkerContentScript(tabId, pingExperimentId);
      });
    } else if (ok) {
      sendResponse({ ok: true, tabId });
      if (pingExperimentId != null) pingWorkerContentScript(tabId, pingExperimentId);
    }
  });
}

/**
 * 다음 실험 URL 로 이동. worker 탭이 있으면 update, 없거나 닫혔으면 create.
 */
function navigateWorkerToExperiment(nextId, state, sendResponse) {
  const url = editUrlForExperiment(nextId);
  const afterNavigateOk = (tabId) => {
    sendResponse({ ok: true });
    pingWorkerContentScript(tabId, nextId);
  };
  const failCreate = (msg) => {
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
  };

  const afterTabReady = (tabId) => {
    if (tabId == null) {
      failCreate("탭 id 없음");
      return;
    }
    chrome.tabs.update(tabId, { url, active: false }, () => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message;
        chrome.tabs.create({ url, active: false }, (tab) => {
          if (chrome.runtime.lastError) {
            failCreate(chrome.runtime.lastError.message || msg);
            return;
          }
          persistWorkerTabIdAndRespond(tab?.id, sendResponse, true, nextId);
        });
        return;
      }
      afterNavigateOk(tabId);
    });
  };

  const wid = state.workerTabId;
  if (wid == null) {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        failCreate(chrome.runtime.lastError.message);
        return;
      }
      persistWorkerTabIdAndRespond(tab?.id, sendResponse, true, nextId);
    });
    return;
  }

  chrome.tabs.get(wid, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      chrome.tabs.create({ url, active: false }, (tab) => {
        if (chrome.runtime.lastError) {
          failCreate(chrome.runtime.lastError.message);
          return;
        }
        persistWorkerTabIdAndRespond(tab?.id, sendResponse, true, nextId);
      });
      return;
    }
    afterTabReady(wid);
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
        workerTabId: null,
      };
      chrome.storage.local.set({ dpsCommerceRunState: state }, () => {
        chrome.tabs.create({ url: editUrlForExperiment(ids[0]), active: false }, (tab) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            chrome.storage.local.remove("dpsCommerceRunState", () => {
              sendResponse({ ok: false, error: msg });
            });
            return;
          }
          persistWorkerTabIdAndRespond(tab?.id, sendResponse, true, ids[0]);
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
        navigateWorkerToExperiment(nextId, state, sendResponse);
      });
    });
    })();
    return true;
  }

  return false;
});
