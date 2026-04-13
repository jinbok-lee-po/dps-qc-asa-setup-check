/**
 * Vendor group filters 텍스트 검증 (Node·CDP·단위 테스트 공용).
 * 익스텐션 content.js 와 동기화.
 *
 * UI A: 영문 라벨 (Vendor ids / Vertical type / Delivery types)
 * UI B: Clause · is · Clause · Values … Values (포털 실제 innerText)
 *
 * Delivery / Vendor id: Vertical 과 같이 해당 라벨·is·Values(또는 레거시 한 줄)에 묶어 검증.
 * 라벨 없는 Clause/Values 전용 UI 는 PLATFORM_DELIVERY·숫자-only Values 각각 단일 블록만 허용.
 * Vendor id 토큰은 숫자만 허용.
 */

const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
const DELIVERY_TYPES_LABEL = /delivery\s+types?\b/i;
const PLATFORM_DELIVERY_VALUE = /\bPLATFORM[\s_-]+DELIVERY\b/i;
const NEXT_FILTER_AFTER_VALUE = /\n\s*(?:Delivery types?|Vertical type|Vendor ids|Add filter)\b/i;

/**
 * "Values" 와 다음 "Values" 사이 텍스트를 순서대로 수집.
 */
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

function extractDeliveryTypesValuesInner(section) {
  const labelRe = /delivery\s*types?\b/i;
  const lm = section.match(labelRe);
  if (!lm || lm.index == null) return { inner: null, mode: "none" };
  let rest = section.slice(lm.index + lm[0].length);
  const isM = rest.match(/\bis\b/i);
  if (!isM) return { inner: null, mode: "none" };
  rest = rest.slice(isM.index + isM[0].length);
  const vOpen = rest.match(/\bValues\b/i);
  if (vOpen) {
    const after = rest.slice(vOpen.index + vOpen[0].length);
    const vClose = after.match(/\bValues\b/i);
    if (!vClose) return { inner: null, mode: "none" };
    return {
      inner: after.slice(0, vClose.index).trim(),
      mode: "values",
    };
  }
  const stop = rest.search(
    /\n\s*(?:Vertical\s*types?|Vendor ids|Add filter|Delivery\s*types?\b)/i
  );
  const raw = (stop === -1 ? rest : rest.slice(0, stop)).trim();
  return { inner: raw || null, mode: raw ? "legacy" : "none" };
}

function isStrictDeliveryPlatformInner(inner) {
  const t = inner.trim();
  if (!t) {
    return { ok: false, reason: "Delivery type(s) is 다음 값이 비어 있습니다." };
  }
  if (/^PLATFORM[\s_-]+DELIVERY$/i.test(t)) return { ok: true };
  return {
    ok: false,
    reason:
      "Delivery type(s) is 값은 OD용 PLATFORM_DELIVERY(또는 PLATFORM DELIVERY / PLATFORM-DELIVERY)만 허용됩니다.",
  };
}

function checkDeliveryTypeStrict(section, blocks) {
  const platformBlocks = blocks.filter((b) =>
    /^PLATFORM[\s_-]+DELIVERY$/i.test(b.trim())
  );
  const { inner, mode } = extractDeliveryTypesValuesInner(section);

  if (mode === "values") {
    const strict = isStrictDeliveryPlatformInner(inner);
    if (!strict.ok) return { ok: false, detail: strict.reason };
    if (platformBlocks.length !== 1) {
      return {
        ok: false,
        detail:
          platformBlocks.length === 0
            ? "Delivery type(s) is Values 텍스트는 있으나 Clause/Values 목록에서 PLATFORM_DELIVERY 블록을 찾지 못했습니다."
            : `PLATFORM_DELIVERY Values 블록이 ${platformBlocks.length}개입니다. Delivery type(s) is 에 해당하는 블록만 허용됩니다.`,
      };
    }
    return {
      ok: true,
      detail:
        "Delivery type(s) is — Values에 PLATFORM_DELIVERY만 있고, 다른 Values 블록에 OD(중복) 설정이 없습니다.",
    };
  }

  if (mode === "legacy") {
    const strict = isStrictDeliveryPlatformInner(inner);
    if (!strict.ok) return { ok: false, detail: strict.reason };
    if (platformBlocks.length > 0) {
      return {
        ok: false,
        detail:
          "Delivery type(s) is 는 레거시 한 줄인데, Clause/Values 블록에도 PLATFORM_DELIVERY가 있습니다.",
      };
    }
    return {
      ok: true,
      detail: `Delivery types is ${inner.trim()} 확인됨 (레거시 UI).`,
    };
  }

  if (platformBlocks.length === 1) {
    const strict = isStrictDeliveryPlatformInner(platformBlocks[0]);
    if (!strict.ok) {
      return {
        ok: false,
        detail: "Values에 PLATFORM_DELIVERY(OD) 형태가 아닌 블록이 있습니다.",
      };
    }
    return {
      ok: true,
      detail:
        "Clause/Values UI — Delivery 라벨 없이 PLATFORM_DELIVERY 단일 Values 블록 확인 (OD).",
    };
  }
  if (platformBlocks.length > 1) {
    return {
      ok: false,
      detail: `PLATFORM_DELIVERY Values 블록이 ${platformBlocks.length}개입니다. OD 설정은 하나만 허용됩니다.`,
    };
  }

  const legacy = checkDeliveryTypesPlatform(section);
  if (!legacy.ok) return { ok: false, detail: legacy.detail };
  return { ok: true, detail: legacy.detail };
}

function extractVendorIdsValuesInner(section) {
  const labelRe = /vendor\s*ids\b/i;
  const lm = section.match(labelRe);
  if (!lm || lm.index == null) return { inner: null, mode: "none" };
  let rest = section.slice(lm.index + lm[0].length);
  const isM = rest.match(/\bis\b/i);
  if (!isM) return { inner: null, mode: "none" };
  rest = rest.slice(isM.index + isM[0].length);
  const vOpen = rest.match(/\bValues\b/i);
  if (vOpen) {
    const after = rest.slice(vOpen.index + vOpen[0].length);
    const vClose = after.match(/\bValues\b/i);
    if (!vClose) return { inner: null, mode: "none" };
    return {
      inner: after.slice(0, vClose.index).trim(),
      mode: "values",
    };
  }
  const afterIs = rest;
  const stop = afterIs.search(NEXT_FILTER_AFTER_VALUE);
  const raw = (stop === -1 ? afterIs : afterIs.slice(0, stop)).trim();
  return { inner: raw, mode: "legacy" };
}

function checkVendorIdsStrict(section, blocks) {
  const numericBlocks = blocks.filter((b) => {
    const tokens = tokensInBlock(b);
    return tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
  });

  const { inner, mode } = extractVendorIdsValuesInner(section);

  if (mode === "values" || mode === "legacy") {
    const tokens = tokensInBlock(inner || "");
    if (tokens.length === 0) {
      return {
        ok: true,
        count: 0,
        ids: [],
        detail:
          mode === "values"
            ? "Vendor ids is Values가 비어 있습니다 (0개)."
            : "Vendor ids is 다음에 값이 없습니다 (0개).",
      };
    }
    if (!tokens.every((t) => /^\d+$/.test(t))) {
      return {
        ok: false,
        count: null,
        ids: null,
        detail: "Vendor ids is 값은 숫자 id만 허용됩니다.",
      };
    }
    if (mode === "values") {
      if (numericBlocks.length !== 1) {
        return {
          ok: false,
          count: null,
          ids: null,
          detail:
            numericBlocks.length === 0
              ? "Vendor ids is Values 텍스트는 있으나 Clause/Values 목록에서 숫자-only 블록을 찾지 못했습니다."
              : `숫자-only Vendor Values 블록이 ${numericBlocks.length}개입니다. Vendor ids is 에 해당하는 블록만 허용됩니다.`,
        };
      }
      const nbTok = tokensInBlock(numericBlocks[0]);
      if (JSON.stringify(nbTok) !== JSON.stringify(tokens)) {
        return {
          ok: false,
          count: null,
          ids: null,
          detail: "Vendor ids is Values 와 Clause/Values 목록의 숫자 블록이 일치하지 않습니다.",
        };
      }
      return {
        ok: true,
        count: tokens.length,
        ids: tokens,
        detail: `Vendor ids is — Values 기준 vendor id ${tokens.length}개: ${tokens.join(", ")}`,
      };
    }
    if (numericBlocks.length > 0) {
      return {
        ok: false,
        count: null,
        ids: null,
        detail:
          "Vendor ids is 는 레거시 텍스트인데, Clause/Values 블록에도 숫자-only vendor Values가 있습니다.",
      };
    }
    return {
      ok: true,
      count: tokens.length,
      ids: tokens,
      detail: `Vendor ids is 다음 vendor id(그룹) 개수: ${tokens.length}개: ${tokens.join(", ")}`,
    };
  }

  if (numericBlocks.length === 0) {
    return {
      ok: false,
      count: null,
      ids: null,
      detail:
        '"Vendor ids" 라벨이 없고, 숫자-only Values(vendor) 블록도 찾지 못했습니다.',
    };
  }
  if (numericBlocks.length > 1) {
    return {
      ok: false,
      count: null,
      ids: null,
      detail: `숫자-only Values 블록이 ${numericBlocks.length}개입니다. vendor id 필터는 하나만 허용됩니다.`,
    };
  }
  const tokens = tokensInBlock(numericBlocks[0]);
  return {
    ok: true,
    count: tokens.length,
    ids: tokens,
    detail: `Clause/Values UI — Vendor 라벨 없이 숫자-only Values 단일 블록: ${tokens.length}개: ${tokens.join(", ")}`,
  };
}

/**
 * "Vertical type(s)" 이후 첫 "is" 다음 — Values…Values 안쪽 또는 레거시 한 줄 값.
 */
function extractVerticalTypeValuesInner(section) {
  const labelRe = /vertical\s*types?\b/i;
  const lm = section.match(labelRe);
  if (!lm || lm.index == null) return { inner: null, mode: "none" };
  let rest = section.slice(lm.index + lm[0].length);
  const isM = rest.match(/\bis\b/i);
  if (!isM) return { inner: null, mode: "none" };
  rest = rest.slice(isM.index + isM[0].length);
  const vOpen = rest.match(/\bValues\b/i);
  if (vOpen) {
    const after = rest.slice(vOpen.index + vOpen[0].length);
    const vClose = after.match(/\bValues\b/i);
    if (!vClose) return { inner: null, mode: "none" };
    return {
      inner: after.slice(0, vClose.index).trim(),
      mode: "values",
    };
  }
  const stop = rest.search(
    /\n\s*(?:Delivery types?|Vendor ids|Add filter|Vertical\s*types?\b)/i
  );
  const raw = (stop === -1 ? rest : rest.slice(0, stop)).trim();
  return { inner: raw || null, mode: raw ? "legacy" : "none" };
}

function isStrictVerticalOnlyToken(inner) {
  const t = inner.trim();
  if (!t) {
    return { ok: false, reason: "Vertical type(s) is 다음 값이 비어 있습니다." };
  }
  if (/^shop$/i.test(t)) return { ok: true, value: "shop" };
  if (/^restaurant$/i.test(t)) return { ok: true, value: "restaurant" };
  return {
    ok: false,
    reason:
      "Vertical type(s) is Values(또는 한 줄 값)에는 shop 또는 restaurant만 단독으로 와야 합니다. 다른 값과 함께 올 수 없습니다.",
  };
}

function checkVerticalTypeStrict(section, blocks) {
  const { inner, mode } = extractVerticalTypeValuesInner(section);
  if (inner == null || inner === "") {
    return {
      ok: false,
      detail:
        'Vendor group filters에서 "Vertical type(s)" · "is" 다음에 shop/restaurant(또는 해당 Values)를 찾지 못했습니다.',
    };
  }
  const strict = isStrictVerticalOnlyToken(inner);
  if (!strict.ok) {
    return { ok: false, detail: strict.reason };
  }
  const want = strict.value.toLowerCase();

  const shopLikeBlocks = blocks.filter((b) => {
    const x = b.trim();
    return /^shop$/i.test(x) || /^restaurant$/i.test(x);
  });

  for (const b of shopLikeBlocks) {
    if (b.trim().toLowerCase() !== want) {
      return {
        ok: false,
        detail: `Vertical은 ${want}인데, 다른 Values 블록에 ${b.trim()}가 있습니다.`,
      };
    }
  }

  if (shopLikeBlocks.length > 1) {
    return {
      ok: false,
      detail: `shop/restaurant이 들어간 Values 블록이 ${shopLikeBlocks.length}개입니다. Vertical type(s) is 에 해당하는 블록만 허용됩니다.`,
    };
  }

  if (mode === "values") {
    if (shopLikeBlocks.length !== 1) {
      return {
        ok: false,
        detail:
          shopLikeBlocks.length === 0
            ? "Vertical type(s) is Values 텍스트는 있으나 Clause/Values 목록에서 shop/restaurant 블록을 찾지 못했습니다."
            : "Vertical type(s) is 에 해당하는 Values는 하나만 있어야 합니다.",
      };
    }
  }

  if (mode === "legacy" && shopLikeBlocks.length > 0) {
    return {
      ok: false,
      detail:
        "Vertical type(s) is 는 레거시 한 줄인데, Clause/Values 블록에도 shop/restaurant가 있습니다.",
    };
  }

  const detail =
    want === "shop"
      ? mode === "values"
        ? "Vertical type(s) is — Values에 shop만 있고, 다른 Values 블록에는 vertical 값이 없습니다."
        : "Vertical type(s) is shop 확인됨 (레거시 UI)."
      : mode === "values"
        ? `Vertical type(s) is — Values에 ${want}만 있고, 다른 Values 블록에는 vertical 값이 없습니다.`
        : `Vertical type(s) is ${want} 확인됨 (레거시 UI).`;

  return { ok: true, detail };
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

export function validateVendorGroupFilters(iframeText) {
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
  const vendorIds = checkVendorIdsStrict(section, blocks);

  const verticalCheck = checkVerticalTypeStrict(section, blocks);
  const verticalOk = verticalCheck.ok;
  const verticalDetail = verticalCheck.detail;

  const deliveryCheck = checkDeliveryTypeStrict(section, blocks);
  const deliveryOk = deliveryCheck.ok;
  const deliveryDetail = deliveryCheck.detail;

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

function verticalReportValue(verticalCheck) {
  if (!verticalCheck.ok) return verticalCheck.detail || "NG";
  const d = verticalCheck.detail || "";
  if (/restaurant/i.test(d)) return "restaurant";
  if (/shop/i.test(d)) return "shop";
  return "OK";
}

/**
 * 익스텐션 content.js `buildReportText` 와 동일한 문자열 (문구 수정 시 양쪽 동기화).
 * @param {Array<{ experimentId: number, ok?: boolean, detail?: string, checks?: object, error?: string }>} results
 */
export function buildVendorGroupFiltersReportText(results) {
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
