#!/usr/bin/env node
/**
 * content.js 의 validateVendorGroupFilters 와 동일 로직 유지.
 */

const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
const VERTICAL_TYPE_IS_SHOP = /vertical\s*type[\s\S]{0,500}?\bis\b[\s\S]{0,240}?\bshop\b/i;
const DELIVERY_TYPES_IS_PLATFORM = /delivery\s*types[\s\S]{0,400}?\bis\b[\s\S]{0,320}?\bPLATFORM_DELIVERY\b/i;
const NEXT_FILTER_AFTER_VALUE = /\n\s*(?:Delivery types|Vertical type|Vendor ids|Add filter)\b/i;

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

function validateVendorGroupFilters(iframeText) {
  const t = iframeText || "";
  if (!t.trim()) {
    return { ok: false, checks: null, detail: "iframe 본문 텍스트가 비어 있습니다." };
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

  const deliveryOk = DELIVERY_TYPES_IS_PLATFORM.test(section);
  const deliveryDetail = deliveryOk
    ? 'Delivery types is PLATFORM_DELIVERY 확인됨.'
    : 'Vendor group filters 이후 "Delivery types" · "is" · "PLATFORM_DELIVERY" 조합을 찾지 못했습니다.';

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

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

const fullMock = `
Vendor group filters
Vendor ids
is
111, 222, 333
Delivery types
is
PLATFORM_DELIVERY
Vertical type
is
shop
`;

console.log("test-vendor-group-filters.mjs\n");

let r = validateVendorGroupFilters(fullMock);
assert(r.ok === true, "full mock should pass");
assert(r.checks.vendorIds.count === 3, "vendor id count 3");
console.log("OK: 전체 통과 목, vendorIds=3");

r = validateVendorGroupFilters("Vendor group filters\nVendor ids\nis\na\nb\nDelivery types\nis\nPLATFORM_DELIVERY\nVertical type\nis\nshop");
assert(r.ok === true, "newline-separated ids");
assert(r.checks.vendorIds.count === 2, "two ids");
console.log("OK: 줄바꿈 구분 id 2개");

r = validateVendorGroupFilters(fullMock.replace("PLATFORM_DELIVERY", "PICKUP"));
assert(r.ok === false, "wrong delivery");
assert(r.checks.deliveryTypesPlatform.ok === false, "delivery ng");
console.log("OK: Delivery types 불통과(예상)");

r = validateVendorGroupFilters(fullMock.replace("shop", "mart"));
assert(r.ok === false, "wrong vertical");
console.log("OK: Vertical type 불통과(예상)");

r = validateVendorGroupFilters("Vendor group filters\nVertical type\nis\nshop\nDelivery types\nis\nPLATFORM_DELIVERY");
assert(r.ok === false, "missing vendor ids");
assert(r.checks.vendorIds.ok === false, "vendor ids parse fail");
console.log("OK: Vendor ids 없음 불통과(예상)");

console.log("\n전부 통과.");
