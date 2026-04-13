#!/usr/bin/env node
/**
 * 레거시 파일명 유지. 커머스 Vendor group filters CDP 검증은 아래를 사용하세요.
 *
 *   node scripts/run-vendor-group-cdp.mjs <실험ID> [--target <cdp-target-prefix>]
 *
 * 단위 테스트:
 *   node scripts/test-vendor-group-filters.mjs
 */

console.error("이 스크립트는 사용하지 않습니다. 대신:\n  node scripts/run-vendor-group-cdp.mjs <실험ID>\n");
process.exit(2);
