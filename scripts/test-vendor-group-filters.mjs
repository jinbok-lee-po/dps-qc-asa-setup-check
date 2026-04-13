#!/usr/bin/env node
/**
 * vendor-group-filters-logic.mjs 단위 테스트 (content.js 와 규칙 동일).
 */

import {
  buildVendorGroupFiltersReportText,
  validateVendorGroupFilters,
} from "./vendor-group-filters-logic.mjs";

/** 포털 실제 innerText 샘플 (Clause / Values) */
const PORTAL_CLAUSE_VALUES_SAMPLE = `Vendor Group Filters
Add Filter
Filter
Filter
Clause
is
Clause
Values
99999999
99999998
Values

Top 50 items shown in the dropdown (search for more); refresh if items missing.

Vertical type
Filter
Filter
Clause
is
Clause
Values
shop
Values
Filter
Filter
Clause
is
Clause
Values
PLATFORM_DELIVERY
Values
Filter
Filter
Clause
is
Clause
Values
딜리버리왕국 - 99
Values
Show Number Of Vendors
`;

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

let r = validateVendorGroupFilters(PORTAL_CLAUSE_VALUES_SAMPLE);
assert(r.ok === true, "portal Clause/Values sample should pass");
assert(r.checks.vendorIds.count === 2, "portal vendor id count 2");
assert(
  JSON.stringify(r.checks.vendorIds.ids) === JSON.stringify(["99999999", "99999998"]),
  "portal vendor id list"
);
assert(r.checks.deliveryTypesPlatform.ok === true, "portal PLATFORM_DELIVERY");
assert(r.checks.verticalTypeShop.ok === true, "portal shop");
console.log("OK: 포털 Clause/Values 실제 샘플 전체 통과");

r = validateVendorGroupFilters(fullMock);
assert(r.ok === true, "full mock should pass");
assert(r.checks.vendorIds.count === 3, "vendor id count 3");
assert(r.checks.vendorIds.ids.length === 3, "legacy vendor id list length");
console.log("OK: 전체 통과 목, vendorIds=3");

r = validateVendorGroupFilters(
  "Vendor group filters\nVendor ids\nis\n11\n22\nDelivery types\nis\nPLATFORM_DELIVERY\nVertical type\nis\nshop"
);
assert(r.ok === true, "newline-separated numeric ids");
assert(r.checks.vendorIds.count === 2, "two ids");
console.log("OK: 줄바꿈 구분 숫자 id 2개");

r = validateVendorGroupFilters(
  "Vendor group filters\nVendor ids\nis\na\nb\nDelivery types\nis\nPLATFORM_DELIVERY\nVertical type\nis\nshop"
);
assert(r.ok === false, "non-numeric vendor ids should fail");
assert(r.checks.vendorIds.ok === false, "vendor ids ng");
console.log("OK: 비숫자 vendor id 불통과(예상)");

r = validateVendorGroupFilters(fullMock.replace("PLATFORM_DELIVERY", "PICKUP"));
assert(r.ok === false, "wrong delivery");
assert(r.checks.deliveryTypesPlatform.ok === false, "delivery ng");
console.log("OK: Delivery types 불통과(예상)");

r = validateVendorGroupFilters(
  "Vendor group filters\nDelivery type\nis\nPLATFORM DELIVERY\nVertical type\nis\nshop\nVendor ids\nis\n1"
);
assert(r.ok === true, "Delivery type singular + PLATFORM DELIVERY with space");
console.log("OK: Delivery type + PLATFORM DELIVERY(공백)");

r = validateVendorGroupFilters(fullMock.replace("shop", "mart"));
assert(r.ok === false, "wrong vertical");
console.log("OK: Vertical type 불통과(예상)");

r = validateVendorGroupFilters("Vendor group filters\nVertical type\nis\nshop\nDelivery types\nis\nPLATFORM_DELIVERY");
assert(r.ok === false, "missing vendor ids");
assert(r.checks.vendorIds.ok === false, "vendor ids parse fail");
console.log("OK: Vendor ids 없음 불통과(예상)");

const DUPLICATE_SHOP = `Vendor group filters
Vertical type
Filter
Clause
is
Clause
Values
shop
Values
Filter
Clause
is
Clause
Values
shop
Values
Delivery types
is
PLATFORM_DELIVERY
Vendor ids
is
1
`;
r = validateVendorGroupFilters(DUPLICATE_SHOP);
assert(r.ok === false, "duplicate shop Values blocks");
assert(r.checks.verticalTypeShop.ok === false, "vertical ng on duplicate shop");
console.log("OK: shop Values 중복 불통과(예상)");

const SHOP_WITH_EXTRA = `Vendor group filters
Vertical type
Clause
is
Clause
Values
shop, mart
Values
Vendor ids
is
1
Delivery types
is
PLATFORM_DELIVERY
`;
r = validateVendorGroupFilters(SHOP_WITH_EXTRA);
assert(r.ok === false, "vertical values not only shop");
assert(r.checks.verticalTypeShop.ok === false, "vertical strict token");
console.log("OK: Vertical is 값에 shop 외 토큰 불통과(예상)");

const SHOP_NO_LABEL = `Vendor group filters
Clause
is
Clause
Values
shop
Values
Vendor ids
is
1
Delivery types
is
PLATFORM_DELIVERY
`;
r = validateVendorGroupFilters(SHOP_NO_LABEL);
assert(r.ok === true, "shop without Vertical label: unlabeled fallback");
assert(r.checks.verticalTypeShop.ok === true, "vertical unlabeled ok");
assert(r.checks.verticalTypeShop.clause === "is", "vertical inferred is (no label)");
console.log("OK: Vertical 라벨 없이 shop 단일 Values → is 로 간주해 통과");

const MOCK_485 = `Vendor group filters
Vendor ids
is
99999999
99999998
Vertical type
is not
shop
Delivery types
is not
PLATFORM_DELIVERY
`;
r = validateVendorGroupFilters(MOCK_485);
assert(r.ok === false, "485 is not vertical + delivery → 규칙 NG");
assert(r.checks.verticalTypeShop.ok === false, "vertical NG");
assert(r.checks.verticalTypeShop.clause === "is_not", "vertical clause is_not");
assert(r.checks.deliveryTypesPlatform.ok === false, "delivery NG");
assert(r.checks.deliveryTypesPlatform.clause === "is_not", "delivery clause is_not");
console.log("OK: Vertical/Delivery is not (485 유형) 불통과(예상)");

const UNLABELED_485_STYLE = `Vendor group filters
Clause
is
Clause
Values
99999999
99999998
Values
Clause
is
not
Clause
Values
shop
Values
Clause
is
not
Clause
Values
PLATFORM_DELIVERY
Values
`;
r = validateVendorGroupFilters(UNLABELED_485_STYLE);
assert(r.ok === false, "unlabeled innerText is not → 규칙 NG");
assert(r.checks.verticalTypeShop.ok === false, "vertical NG inferred");
assert(r.checks.verticalTypeShop.clause === "is_not", "vertical is_not inferred");
assert(r.checks.deliveryTypesPlatform.ok === false, "delivery NG inferred");
assert(r.checks.deliveryTypesPlatform.clause === "is_not", "delivery is_not inferred");
console.log("OK: 라벨 없이 is/not 줄바꿈 (485 innerText 유사) → 불통과(예상)");

const fullMockRestaurants = fullMock.replace(
  /Vertical type\nis\nshop/,
  "Vertical type\nis\nrestaurants"
);
r = validateVendorGroupFilters(fullMockRestaurants);
assert(r.ok === false, "비마트 기본값 + restaurants Vertical → NG");
assert(r.checks.verticalTypeShop.ok === false, "bmart mismatch");

r = validateVendorGroupFilters(fullMockRestaurants, { verticalSegment: "food" });
assert(r.ok === true, "푸드 + restaurants 통과");
assert(r.checks.verticalTypeShop.verticalToken === "restaurants", "token restaurants");

r = validateVendorGroupFilters(fullMock, { verticalSegment: "food" });
assert(r.ok === false, "푸드 + shop → NG");
console.log("OK: verticalSegment bmart/food 기대값 분기");

r = validateVendorGroupFilters(PORTAL_CLAUSE_VALUES_SAMPLE, { verticalSegment: "food" });
assert(r.ok === false, "포털 샘플 shop 을 푸드로 검사하면 NG");

const FOOD_PORTAL = PORTAL_CLAUSE_VALUES_SAMPLE.replace(
  /(Vertical type[\s\S]*?Values\n)shop(\nValues)/i,
  "$1restaurants$2"
);
r = validateVendorGroupFilters(FOOD_PORTAL, { verticalSegment: "food" });
assert(r.ok === true, "푸드 포털 샘플 통과");
console.log("OK: 푸드 포털 샘플 (restaurants)");

r = validateVendorGroupFilters(
  "Vendor group filters\nVertical type\nis\nrestaurant\nDelivery types\nis\nPLATFORM_DELIVERY\nVendor ids\nis\n1",
  { verticalSegment: "food" }
);
assert(r.ok === false, "푸드인데 restaurant 단수 → 미사용 토큰");
assert(
  (r.checks.verticalTypeShop.detail || "").includes("restaurants") ||
    (r.checks.verticalTypeShop.detail || "").includes("복수"),
  "단수 restaurant 안내"
);

r = validateVendorGroupFilters(
  "Vendor group filters\nVertical type\nis\nrestaurants\nDelivery types\nis\nPLATFORM_DELIVERY\nVendor ids\nis\n1",
  { verticalSegment: "food" }
);
assert(r.ok === true, "Values restaurants 단일 허용(푸드)");
console.log("OK: Vertical 값 restaurants (푸드)");

r = validateVendorGroupFilters(SHOP_NO_LABEL, { verticalSegment: "food" });
assert(r.ok === false, "라벨 없이 shop 인데 푸드 선택 → NG");
console.log("OK: SHOP_NO_LABEL / restaurants 엣지");

{
  const v = validateVendorGroupFilters(PORTAL_CLAUSE_VALUES_SAMPLE);
  const report = buildVendorGroupFiltersReportText(
    [{ experimentId: 483, ok: v.ok, detail: v.detail, checks: v.checks }],
    { verticalSegment: "bmart" }
  );
  assert(report.includes("=== 검증 항목 ==="), "report header");
  assert(report.includes("(1) Vertical — 커머스 기준: is shop"), "report vertical criterion");
  assert(report.includes("실험 ID: 483 - 정상"), "report experiment status");
  assert(report.includes("(1) Vertical\tOK\tshop"), "report vertical line");
  assert(report.includes("(2) delivery\tOK\tPLATFORM_DELIVERY"), "report delivery line");
  assert(report.includes("(3) Vendor id\t2개\t99999999, 99999998"), "report vendor line");
  assert(report.includes("요약: 통과 1"), "report summary");
  assert(report.includes('"verticalSegment": "bmart"'), "report json segment");
  assert(report.includes('"experimentId": 483'), "report trailing JSON");
  console.log("OK: CDP/익스텐션 공통 리포트 문자열 (비마트)");
}

{
  const vf = validateVendorGroupFilters(FOOD_PORTAL, { verticalSegment: "food" });
  const reportF = buildVendorGroupFiltersReportText(
    [{ experimentId: 484, ok: vf.ok, detail: vf.detail, checks: vf.checks }],
    { verticalSegment: "food" }
  );
  assert(reportF.includes("(1) Vertical — 푸드 기준: is restaurants"), "report food criterion");
  assert(reportF.includes('"verticalSegment": "food"'), "report json food");
  console.log("OK: 리포트 헤더 푸드 기준");
}

console.log("\n전부 통과.");
