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
        detail: `Clause/Values UI — vendor id ${tokens.length}개`,
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
    return { ok: false, count: null, detail: '"Vendor ids" · "is" 패턴을 찾지 못했습니다.' };
  }
  const afterIs = fromVendorGroupFilters.slice(m.index + m[0].length);
  const stop = afterIs.search(NEXT_FILTER_AFTER_VALUE);
  const raw = (stop === -1 ? afterIs : afterIs.slice(0, stop)).trim();
  if (!raw) {
    return { ok: true, count: 0, detail: "Vendor ids is 다음에 값이 없습니다 (0개)." };
  }
  const parts = raw
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    ok: true,
    count: parts.length,
    detail: `Vendor ids is 다음 vendor id(그룹) 개수: ${parts.length}개`,
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
