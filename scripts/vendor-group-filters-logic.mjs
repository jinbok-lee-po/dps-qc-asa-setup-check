/**
 * Vendor group filters 텍스트 검증 (Node·CDP·단위 테스트 공용).
 * 익스텐션 content.js 와 동일 규칙 유지할 것.
 */

const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
const VERTICAL_TYPE_IS_SHOP = /vertical\s*type[\s\S]{0,500}?\bis\b[\s\S]{0,240}?\bshop\b/i;
/** Delivery type / Delivery types 라벨 (대소문자 무시) */
const DELIVERY_TYPES_LABEL = /delivery\s+types?\b/i;
/** PLATFORM_DELIVERY · PLATFORM DELIVERY · PLATFORM-DELIVERY 등 */
const PLATFORM_DELIVERY_VALUE = /\bPLATFORM[\s_-]+DELIVERY\b/i;
const NEXT_FILTER_AFTER_VALUE = /\n\s*(?:Delivery types?|Vertical type|Vendor ids|Add filter)\b/i;

/**
 * Vendor group filters 구간에서 Delivery type(s) … is … PLATFORM_*DELIVERY 를 찾는다.
 * 한 줄에 붙어 있거나, 라벨·연산자·값이 멀리 떨어져 있어도 라벨~값 구간 안에 is 가 있으면 통과.
 */
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

  const verticalOk = VERTICAL_TYPE_IS_SHOP.test(section);
  const verticalDetail = verticalOk
    ? "Vertical type is shop 확인됨."
    : 'Vendor group filters 이후 "Vertical type" · "is" · "shop" 조합을 찾지 못했습니다.';

  const vendorIds = parseVendorIdsCountAfterIs(section);

  const delivery = checkDeliveryTypesPlatform(section);
  const deliveryOk = delivery.ok;
  const deliveryDetail = delivery.detail;

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
