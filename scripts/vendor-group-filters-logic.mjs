/**
 * Vendor group filters 텍스트 검증 (Node·CDP·단위 테스트 공용).
 * 익스텐션 content.js 와 동기화.
 *
 * UI A: 영문 라벨 (Vendor ids / Vertical type / Delivery types)
 * UI B: Clause · is · Clause · Values … Values (포털 실제 innerText)
 */

const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
/** 레거시: Vertical type … is … shop */
const VERTICAL_TYPE_IS_SHOP = /vertical\s*type[\s\S]{0,500}?\bis\b[\s\S]{0,240}?\bshop\b/i;
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

/** 첫 번째 "숫자만" Values 블록 → vendor id 개수 */
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
