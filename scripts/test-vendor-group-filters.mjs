#!/usr/bin/env node
/**
 * vendor-group-filters-logic.mjs 단위 테스트 (content.js 와 규칙 동일).
 */

import { validateVendorGroupFilters } from "./vendor-group-filters-logic.mjs";

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
