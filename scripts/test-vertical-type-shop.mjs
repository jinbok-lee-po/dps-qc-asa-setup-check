#!/usr/bin/env node
/**
 * Vendor group filters / Vertical type is shop 검증 로직 단위 테스트.
 * 익스텐션 content.js 의 VENDOR_GROUP_MARK · VERTICAL_TYPE_IS_SHOP 과 동일하게 유지할 것.
 */

const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
const VERTICAL_TYPE_IS_SHOP = /vertical\s*type[\s\S]{0,500}?\bis\b[\s\S]{0,240}?\bshop\b/i;

function validateVendorGroupVerticalTypeShop(iframeText) {
  const t = iframeText || "";
  if (!t.trim()) {
    return { ok: false, detail: "iframe 본문 텍스트가 비어 있습니다." };
  }
  const m = t.match(VENDOR_GROUP_MARK);
  if (!m || m.index == null) {
    return {
      ok: false,
      detail: '화면에 "Vendor group filters" 문구가 없습니다.',
    };
  }
  const fromMark = t.slice(m.index);
  if (!VERTICAL_TYPE_IS_SHOP.test(fromMark)) {
    return {
      ok: false,
      detail:
        'Vendor group filters 이후 텍스트에서 "Vertical type" · "is" · "shop" 조합을 찾지 못했습니다. (연산자는 is, 값은 shop 단어)',
    };
  }
  return { ok: true, detail: "Vertical type is shop 확인됨." };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// 실험 461 edit 화면을 가정한 플러그인 iframe innerText 예시 (실제 DOM과 다를 수 있음)
const mockExperiment461Like = `
Automatic assignment
Experiment 461
Vendor group filters
Add filter
Vertical type
is
shop
Some other section
`;

const cases = [
  {
    name: "461 유사: Vendor group filters + Vertical type is shop",
    text: mockExperiment461Like,
    expectOk: true,
  },
  {
    name: "한 줄로 붙은 경우",
    text: "Vendor group filters\nVertical type is shop",
    expectOk: true,
  },
  {
    name: "Vendor group 없음",
    text: "Vertical type\nis\nshop",
    expectOk: false,
  },
  {
    name: "shop 대신 restaurant",
    text: "Vendor group filters\nVertical type\nis\nrestaurant",
    expectOk: false,
  },
];

console.log("test-vertical-type-shop.mjs (실제 포털 461 접속 아님, 로직만 검증)\n");

for (const c of cases) {
  const r = validateVendorGroupVerticalTypeShop(c.text);
  assert(r.ok === c.expectOk, `${c.name}: expected ok=${c.expectOk}, got ok=${r.ok} (${r.detail})`);
  console.log("OK:", c.name, "→", r.ok ? "통과" : "불통과(예상)");
}

console.log("\n전부 통과. 실험 461 실제 화면은 크롬에서 익스텐션으로 확인하세요.");
