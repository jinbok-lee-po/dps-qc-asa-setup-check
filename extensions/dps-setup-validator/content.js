(() => {
  /**
   * 네비: 부모·iframe 을 조작하지 않음. background 가 worker 탭을 연 뒤(첫 번만 create) 이후는 tabs.update 로 edit URL 만 바꿈.
   * (CDP 스크립트 run-vendor-group-cdp.mjs 는 별도)
   *
   * - 실행 시 background 가 첫 실험 edit URL 을 백그라운드 탭에서 연다(포그라운드 전환 없음). 여러 ID 면 그 탭에서 URL 만 순서대로 전환.
   * - 해시·history·background ping 시 dpsAutoRunConsumed 해제(상단 또는 iframe 이 대기 id 와 맞을 때도 해제).
   * - 첫 실험만 긴 post-load 대기, 이후 단계는 짧은 대기 후 iframe innerText 폴링 → STEP_DONE.
   * - 최종 결과는 chrome.storage 로 실행을 눌렀던 탭 패널에 표시.
   */
  const VERSION = "0.6.5";
  const POLL_MS = 600;
  const MAX_MS = 45000;
  /** 첫 worker 로드(콜드 스타트) — 이후 단계는 SPA 전환만 있어 더 짧게 */
  const FIRST_POST_LOAD_WAIT_MS = 7000;
  const NEXT_POST_LOAD_WAIT_MS = 3500;
  /** 새 탭에서 상단 URL·iframe 이 edit 와 맞을 때까지 (SPA·replaceState 지연) */
  const ROUTE_ALIGN_WAIT_MS = 45000;
  const ROUTE_ALIGN_POLL_MS = 250;
  const OPENER_WAIT_TOTAL_MS = 25 * 60 * 1000;
  const BASE_PATH = "/pv2/kr/p/logistics-dynamic-pricing";
  const ORIGIN = "https://portal.woowahan.com";
  const COMMERCE_HASH_PREFIX = "#/automatic-assignment";

  /** 검증 규칙은 scripts/vendor-group-filters-logic.mjs 와 동기화 */
  const VENDOR_GROUP_MARK = /vendor\s+group\s+filters/i;
  const DELIVERY_TYPES_LABEL = /delivery\s+types?\b/i;
  const PLATFORM_DELIVERY_VALUE = /\bPLATFORM[\s_-]+DELIVERY\b/i;
  const NEXT_FILTER_AFTER_VALUE = /\n\s*(?:Delivery types?|Vertical type|Vendor ids|Add filter)\b/i;
  const STORAGE_VERTICAL = "dpsCommerceVerticalSegment";

  function normalizeVerticalSegment(seg) {
    const s = String(seg == null ? "bmart" : seg)
      .trim()
      .toLowerCase();
    if (s === "food") return "food";
    return "bmart";
  }

  function expectedVerticalToken(segment) {
    return segment === "food" ? "restaurants" : "shop";
  }

  function verticalSegmentLabelKo(segment) {
    return segment === "food" ? "푸드" : "커머스";
  }

  function wrongVerticalForSegmentDetail(want, segment) {
    const exp = expectedVerticalToken(segment);
    const lab = verticalSegmentLabelKo(segment);
    const expLabel = exp === "shop" ? "shop" : "restaurants";
    return `${lab} 검증 기준: Vertical은 ${expLabel}이어야 하는데 화면 값은 ${want}입니다.`;
  }

  function verticalIsNotFailDetail(want, segment) {
    const lab = verticalSegmentLabelKo(segment);
    const exp = expectedVerticalToken(segment);
    const expWord = exp === "shop" ? "shop" : "restaurants";
    return `Vertical type(s)가 is not ${want} 입니다. ${lab}는 is ${expWord}만 허용됩니다.`;
  }

  function verticalUnlabeledIsNotDetail(want, segment) {
    const lab = verticalSegmentLabelKo(segment);
    const exp = expectedVerticalToken(segment);
    const expWord = exp === "shop" ? "shop" : "restaurants";
    return `Clause/Values UI에서 Vertical이 is not ${want}으로 보입니다. ${lab}는 is ${expWord}만 허용됩니다.`;
  }

  function extractValuesBlockContents(section) {
    return extractValuesBlocksWithMeta(section).map((x) => x.inner);
  }

  /** 각 Values…Values 쌍의 inner + 첫 Values 시작 문자 인덱스 */
  function extractValuesBlocksWithMeta(section) {
    const out = [];
    let searchFrom = 0;
    while (searchFrom < section.length) {
      const sub = section.slice(searchFrom);
      const mOpen = sub.match(/\bValues\b/i);
      if (!mOpen) break;
      const openIndex = searchFrom + mOpen.index;
      const afterOpen = searchFrom + mOpen.index + mOpen[0].length;
      const sub2 = section.slice(afterOpen);
      const mClose = sub2.match(/\bValues\b/i);
      if (!mClose) break;
      const inner = section.slice(afterOpen, afterOpen + mClose.index).trim();
      out.push({ inner, openIndex });
      searchFrom = afterOpen + mClose.index + mClose[0].length;
    }
    return out;
  }

  /** Values 시작 직전 구간에서, 그 행에 가장 가까운 clause (포털: is 와 not 이 줄로 갈라짐) */
  function clauseOperatorNearestBefore(section, cutIndex, lookback = 900) {
    const start = Math.max(0, cutIndex - lookback);
    const slice = section.slice(start, cutIndex);
    let lastNotEnd = -1;
    const rNot = /\bis\b[\s\u00a0\u200b\uFEFF]*\bnot\b/gi;
    let m;
    while ((m = rNot.exec(slice)) !== null) {
      lastNotEnd = m.index + m[0].length;
    }
    let lastPlainEnd = -1;
    const rIs = /\bis\b/gi;
    while ((m = rIs.exec(slice)) !== null) {
      const after = slice.slice(m.index + m[0].length);
      const gap = after.match(/^[\s\u00a0\u200b\uFEFF]*/)[0];
      if (/^not\b/i.test(after.slice(gap.length))) continue;
      lastPlainEnd = m.index + m[0].length;
    }
    if (lastNotEnd < 0 && lastPlainEnd < 0) return null;
    if (lastNotEnd > lastPlainEnd) return "is_not";
    return "is";
  }

  function tokensInBlock(inner) {
    return inner
      .split(/\n/)
      .flatMap((line) => line.split(","))
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function normalizeVerticalValueToken(inner) {
    const t = inner.trim().toLowerCase();
    if (t === "shop") return "shop";
    if (t === "restaurants") return "restaurants";
    return null;
  }

  /** 라벨 직후 가장 이른 is / is not (is·not 사이 NBSP·줄바꿈 허용) */
  function clauseAfterLabel(rest0) {
    let bestNotIdx = Infinity;
    let bestNotLen = 0;
    const rNot = /\bis\b[\s\u00a0\u200b\uFEFF]*\bnot\b/gi;
    let m;
    while ((m = rNot.exec(rest0)) !== null) {
      if (m.index < bestNotIdx) {
        bestNotIdx = m.index;
        bestNotLen = m[0].length;
      }
    }
    let bestPlainIdx = Infinity;
    let bestPlainLen = 0;
    const rIs = /\bis\b/gi;
    while ((m = rIs.exec(rest0)) !== null) {
      const after = rest0.slice(m.index + m[0].length);
      const gap = after.match(/^[\s\u00a0\u200b\uFEFF]*/)[0];
      if (/^not\b/i.test(after.slice(gap.length))) continue;
      if (m.index < bestPlainIdx) {
        bestPlainIdx = m.index;
        bestPlainLen = m[0].length;
      }
    }
    if (bestNotIdx === Infinity && bestPlainIdx === Infinity) {
      return { clause: null, rest: rest0 };
    }
    if (bestNotIdx <= bestPlainIdx) {
      return {
        clause: "is_not",
        rest: rest0.slice(bestNotIdx + bestNotLen),
      };
    }
    return {
      clause: "is",
      rest: rest0.slice(bestPlainIdx + bestPlainLen),
    };
  }

  function extractDeliveryTypesValuesInner(section) {
    const labelRe = /delivery\s*types?\b/i;
    const lm = section.match(labelRe);
    if (!lm || lm.index == null) return { inner: null, mode: "none", clause: null };
    const rest0 = section.slice(lm.index + lm[0].length);
    const { clause, rest: rest1 } = clauseAfterLabel(rest0);
    if (!clause) return { inner: null, mode: "none", clause: null };
    let rest = rest1;
    const vOpen = rest.match(/\bValues\b/i);
    if (vOpen) {
      const after = rest.slice(vOpen.index + vOpen[0].length);
      const vClose = after.match(/\bValues\b/i);
      if (!vClose) return { inner: null, mode: "none", clause };
      return {
        inner: after.slice(0, vClose.index).trim(),
        mode: "values",
        clause,
      };
    }
    const stop = rest.search(
      /\n\s*(?:Vertical\s*types?|Vendor ids|Add filter|Delivery\s*types?\b)/i
    );
    const raw = (stop === -1 ? rest : rest.slice(0, stop)).trim();
    return { inner: raw || null, mode: raw ? "legacy" : "none", clause };
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
    const { inner, mode, clause } = extractDeliveryTypesValuesInner(section);

    if (mode === "values" && clause) {
      const strict = isStrictDeliveryPlatformInner(inner);
      if (!strict.ok) return { ok: false, detail: strict.reason, clause };
      if (platformBlocks.length !== 1) {
        return {
          ok: false,
          detail:
            platformBlocks.length === 0
              ? "Delivery type(s) is / is not Values 텍스트는 있으나 Clause/Values 목록에서 PLATFORM_DELIVERY 블록을 찾지 못했습니다."
              : `PLATFORM_DELIVERY Values 블록이 ${platformBlocks.length}개입니다. Delivery type(s) 에 해당하는 블록만 허용됩니다.`,
          clause,
        };
      }
      if (clause === "is_not") {
        return {
          ok: false,
          detail:
            "Delivery type(s)가 is not PLATFORM_DELIVERY 입니다. OD 설정은 is PLATFORM_DELIVERY만 허용됩니다.",
          clause: "is_not",
        };
      }
      return {
        ok: true,
        detail:
          "Delivery type(s) is — Values에 PLATFORM_DELIVERY만 있고, 다른 Values 블록에 OD(중복) 설정이 없습니다.",
        clause: "is",
      };
    }

    if (mode === "legacy" && clause) {
      const strict = isStrictDeliveryPlatformInner(inner);
      if (!strict.ok) return { ok: false, detail: strict.reason, clause };
      if (platformBlocks.length > 0) {
        return {
          ok: false,
          detail:
            "Delivery type(s) 가 레거시 한 줄인데, Clause/Values 블록에도 PLATFORM_DELIVERY가 있습니다.",
          clause,
        };
      }
      if (clause === "is_not") {
        return {
          ok: false,
          detail: `Delivery types가 is not ${inner.trim()} 입니다. OD는 is PLATFORM_DELIVERY만 허용됩니다.`,
          clause: "is_not",
        };
      }
      return {
        ok: true,
        detail: `Delivery types is ${inner.trim()} 확인됨 (레거시 UI).`,
        clause: "is",
      };
    }

    if (platformBlocks.length === 1) {
      const strict = isStrictDeliveryPlatformInner(platformBlocks[0]);
      if (!strict.ok) {
        return {
          ok: false,
          detail: "Values에 PLATFORM_DELIVERY(OD) 형태가 아닌 블록이 있습니다.",
          clause: null,
        };
      }
      const meta = extractValuesBlocksWithMeta(section);
      const platRow = meta.find((row) =>
        /^PLATFORM[\s_-]+DELIVERY$/i.test(row.inner.trim())
      );
      const inferred = platRow
        ? clauseOperatorNearestBefore(section, platRow.openIndex)
        : null;
      const effClause = inferred || "is";
      if (effClause === "is_not") {
        return {
          ok: false,
          detail:
            "Clause/Values UI에서 Delivery가 is not PLATFORM_DELIVERY로 보입니다. OD는 is PLATFORM_DELIVERY만 허용됩니다.",
          clause: "is_not",
        };
      }
      return {
        ok: true,
        detail:
          "Clause/Values UI — Delivery 라벨 없이 PLATFORM_DELIVERY 단일 Values 블록 확인 (OD).",
        clause: "is",
      };
    }
    if (platformBlocks.length > 1) {
      return {
        ok: false,
        detail: `PLATFORM_DELIVERY Values 블록이 ${platformBlocks.length}개입니다. OD 설정은 하나만 허용됩니다.`,
        clause: null,
      };
    }

    const legacy = checkDeliveryTypesPlatform(section);
    if (!legacy.ok) return { ok: false, detail: legacy.detail, clause: null };
    return { ok: true, detail: legacy.detail, clause: "is" };
  }

  function extractVendorIdsValuesInner(section) {
    const labelRe = /vendor\s*ids\b/i;
    const lm = section.match(labelRe);
    if (!lm || lm.index == null) return { inner: null, mode: "none", clause: null };
    const rest0 = section.slice(lm.index + lm[0].length);
    const { clause, rest } = clauseAfterLabel(rest0);
    if (!clause) return { inner: null, mode: "none", clause: null };
    const vOpen = rest.match(/\bValues\b/i);
    if (vOpen) {
      const after = rest.slice(vOpen.index + vOpen[0].length);
      const vClose = after.match(/\bValues\b/i);
      if (!vClose) return { inner: null, mode: "none", clause };
      return {
        inner: after.slice(0, vClose.index).trim(),
        mode: "values",
        clause,
      };
    }
    const afterIs = rest;
    const stop = afterIs.search(NEXT_FILTER_AFTER_VALUE);
    const raw = (stop === -1 ? afterIs : afterIs.slice(0, stop)).trim();
    return { inner: raw, mode: "legacy", clause };
  }

  function checkVendorIdsStrict(section, blocks) {
    const numericBlocks = blocks.filter((b) => {
      const tokens = tokensInBlock(b);
      return tokens.length > 0 && tokens.every((t) => /^\d+$/.test(t));
    });

    const { inner, mode, clause } = extractVendorIdsValuesInner(section);

    if (mode === "values" || mode === "legacy") {
      const tokens = tokensInBlock(inner || "");
      if (tokens.length === 0) {
        return {
          ok: true,
          count: 0,
          ids: [],
          detail:
            mode === "values"
              ? clause === "is_not"
                ? "Vendor ids is not Values가 비어 있습니다 (0개)."
                : "Vendor ids is Values가 비어 있습니다 (0개)."
              : clause === "is_not"
                ? "Vendor ids is not 다음에 값이 없습니다 (0개)."
                : "Vendor ids is 다음에 값이 없습니다 (0개).",
        };
      }
      if (!tokens.every((t) => /^\d+$/.test(t))) {
        return {
          ok: false,
          count: null,
          ids: null,
          detail: "Vendor ids is / is not 값은 숫자 id만 허용됩니다.",
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
                ? "Vendor ids is / is not Values 텍스트는 있으나 Clause/Values 목록에서 숫자-only 블록을 찾지 못했습니다."
                : `숫자-only Vendor Values 블록이 ${numericBlocks.length}개입니다. Vendor ids 에 해당하는 블록만 허용됩니다.`,
          };
        }
        const nbTok = tokensInBlock(numericBlocks[0]);
        if (JSON.stringify(nbTok) !== JSON.stringify(tokens)) {
          return {
            ok: false,
            count: null,
            ids: null,
            detail: "Vendor ids Values 와 Clause/Values 목록의 숫자 블록이 일치하지 않습니다.",
          };
        }
        return {
          ok: true,
          count: tokens.length,
          ids: tokens,
          detail:
            clause === "is_not"
              ? `Vendor ids is not — Values 기준 vendor id ${tokens.length}개: ${tokens.join(", ")}`
              : `Vendor ids is — Values 기준 vendor id ${tokens.length}개: ${tokens.join(", ")}`,
        };
      }
      if (numericBlocks.length > 0) {
        return {
          ok: false,
          count: null,
          ids: null,
          detail:
            "Vendor ids 가 레거시 텍스트인데, Clause/Values 블록에도 숫자-only vendor Values가 있습니다.",
        };
      }
      return {
        ok: true,
        count: tokens.length,
        ids: tokens,
        detail:
          clause === "is_not"
            ? `Vendor ids is not 다음 vendor id(그룹) 개수: ${tokens.length}개: ${tokens.join(", ")}`
            : `Vendor ids is 다음 vendor id(그룹) 개수: ${tokens.length}개: ${tokens.join(", ")}`,
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

  function extractVerticalTypeValuesInner(section) {
    const labelRe = /vertical\s*types?\b/i;
    const lm = section.match(labelRe);
    if (!lm || lm.index == null) return { inner: null, mode: "none", clause: null };
    const rest0 = section.slice(lm.index + lm[0].length);
    const { clause, rest: rest1 } = clauseAfterLabel(rest0);
    if (!clause) return { inner: null, mode: "none", clause: null };
    let rest = rest1;
    const vOpen = rest.match(/\bValues\b/i);
    if (vOpen) {
      const after = rest.slice(vOpen.index + vOpen[0].length);
      const vClose = after.match(/\bValues\b/i);
      if (!vClose) return { inner: null, mode: "none", clause };
      return {
        inner: after.slice(0, vClose.index).trim(),
        mode: "values",
        clause,
      };
    }
    const stop = rest.search(
      /\n\s*(?:Delivery types?|Vendor ids|Add filter|Vertical\s*types?\b)/i
    );
    const raw = (stop === -1 ? rest : rest.slice(0, stop)).trim();
    return { inner: raw || null, mode: raw ? "legacy" : "none", clause };
  }

  function isStrictVerticalOnlyToken(inner) {
    const t = inner.trim();
    if (!t) {
      return { ok: false, reason: "Vertical type(s) is 다음 값이 비어 있습니다." };
    }
    const norm = normalizeVerticalValueToken(t);
    if (norm === "shop") return { ok: true, value: "shop" };
    if (norm === "restaurants") return { ok: true, value: "restaurants" };
    if (/^restaurant$/i.test(t.trim())) {
      return {
        ok: false,
        reason:
          "Vertical 값이 restaurant(단수)입니다. 푸드는 restaurants(복수)만 사용합니다.",
      };
    }
    return {
      ok: false,
      reason:
        "Vertical type(s) is Values(또는 한 줄 값)에는 shop 또는 restaurants만 단독으로 와야 합니다. 다른 값과 함께 올 수 없습니다.",
    };
  }

  function checkVerticalUnlabeledFallback(section, blocks, verticalSegment) {
    const shopLikeBlocks = blocks.filter((b) => normalizeVerticalValueToken(b) != null);
    if (shopLikeBlocks.length !== 1) {
      return {
        ok: false,
        detail:
          shopLikeBlocks.length === 0
            ? '"Vertical type(s)" 라벨이 innerText에 없고, shop/restaurants 전용 Values 블록도 없습니다.'
            : `Vertical 라벨 없음: shop/restaurants Values가 ${shopLikeBlocks.length}개입니다. 정확히 1개여야 합니다.`,
        clause: "unlabeled",
        verticalToken: null,
      };
    }
    const strict = isStrictVerticalOnlyToken(shopLikeBlocks[0]);
    if (!strict.ok) {
      return {
        ok: false,
        detail: strict.reason,
        clause: "unlabeled",
        verticalToken: null,
      };
    }
    const want = strict.value.toLowerCase();
    const exp = expectedVerticalToken(verticalSegment);
    if (want !== exp) {
      return {
        ok: false,
        detail: wrongVerticalForSegmentDetail(want, verticalSegment),
        clause: "unlabeled",
        verticalToken: want,
      };
    }
    const meta = extractValuesBlocksWithMeta(section);
    const shopRow = meta.find((row) => normalizeVerticalValueToken(row.inner) != null);
    const inferred = shopRow
      ? clauseOperatorNearestBefore(section, shopRow.openIndex)
      : null;
    const effClause = inferred || "is";
    if (effClause === "is_not") {
      return {
        ok: false,
        detail: verticalUnlabeledIsNotDetail(want, verticalSegment),
        clause: "is_not",
        verticalToken: want,
      };
    }
    const lab = verticalSegmentLabelKo(verticalSegment);
    return {
      ok: true,
      detail:
        want === "shop"
          ? `Clause/Values UI — Vertical 라벨 없음, shop 단일 Values (is, ${lab} 기준).`
          : `Clause/Values UI — Vertical 라벨 없음, ${want} 단일 Values (is, ${lab} 기준).`,
      clause: "is",
      verticalToken: want,
    };
  }

  function checkVerticalTypeStrict(section, blocks, verticalSegment) {
    const labeled = extractVerticalTypeValuesInner(section);
    if (labeled.mode === "none" && labeled.clause == null) {
      return checkVerticalUnlabeledFallback(section, blocks, verticalSegment);
    }

    const { inner, mode, clause } = labeled;
    if (inner == null || inner === "") {
      return {
        ok: false,
        detail:
          'Vendor group filters에서 "Vertical type(s)" · is / is not · Values(또는 값)을 찾지 못했습니다.',
        clause: clause || null,
        verticalToken: null,
      };
    }
    const strict = isStrictVerticalOnlyToken(inner);
    if (!strict.ok) {
      return { ok: false, detail: strict.reason, clause, verticalToken: null };
    }
    const want = strict.value.toLowerCase();
    const exp = expectedVerticalToken(verticalSegment);
    if (want !== exp) {
      return {
        ok: false,
        detail: wrongVerticalForSegmentDetail(want, verticalSegment),
        clause,
        verticalToken: want,
      };
    }

    const shopLikeBlocks = blocks.filter((b) => normalizeVerticalValueToken(b) != null);

    for (const b of shopLikeBlocks) {
      const bNorm = normalizeVerticalValueToken(b);
      if (bNorm !== want) {
        return {
          ok: false,
          detail: `Vertical은 ${want}인데, 다른 Values 블록에 ${b.trim()}가 있습니다.`,
          clause,
          verticalToken: null,
        };
      }
    }

    if (shopLikeBlocks.length > 1) {
      return {
        ok: false,
        detail: `shop 또는 restaurants가 들어간 Values 블록이 ${shopLikeBlocks.length}개입니다.`,
        clause,
        verticalToken: null,
      };
    }

    if (clause === "is_not") {
      if (mode === "values") {
        if (shopLikeBlocks.length !== 1) {
          return {
            ok: false,
            detail:
              shopLikeBlocks.length === 0
                ? "Vertical type(s) is not Values 와 목록의 shop/restaurants 블록이 맞지 않습니다."
                : "Vertical type(s) is not 에 해당하는 Values는 하나만 허용됩니다.",
            clause,
            verticalToken: null,
          };
        }
      }
      if (mode === "legacy" && shopLikeBlocks.length > 0) {
        return {
          ok: false,
          detail:
            "Vertical type(s) is not 가 레거시인데 Clause/Values 에도 shop/restaurants 블록이 있습니다.",
          clause,
          verticalToken: null,
        };
      }
      const detail = verticalIsNotFailDetail(want, verticalSegment);
      return { ok: false, detail, clause: "is_not", verticalToken: want };
    }

    if (mode === "values") {
      if (shopLikeBlocks.length !== 1) {
        return {
          ok: false,
          detail:
            shopLikeBlocks.length === 0
              ? "Vertical type(s) is Values 텍스트는 있으나 Clause/Values 목록에서 shop/restaurants 블록을 찾지 못했습니다."
              : "Vertical type(s) is 에 해당하는 Values는 하나만 있어야 합니다.",
          clause,
          verticalToken: null,
        };
      }
    }

    if (mode === "legacy" && shopLikeBlocks.length > 0) {
      return {
        ok: false,
        detail:
          "Vertical type(s) is 는 레거시 한 줄인데, Clause/Values 블록에도 shop/restaurants가 있습니다.",
        clause,
        verticalToken: null,
      };
    }

    const lab = verticalSegmentLabelKo(verticalSegment);
    const detail =
      want === "shop"
        ? mode === "values"
          ? `Vertical type(s) is — Values에 shop만 있고, 다른 Values 블록에는 vertical 값이 없습니다. (${lab} 기준)`
          : `Vertical type(s) is shop 확인됨 (레거시 UI, ${lab} 기준).`
        : mode === "values"
          ? `Vertical type(s) is — Values에 ${want}만 있고, 다른 Values 블록에는 vertical 값이 없습니다. (${lab} 기준)`
          : `Vertical type(s) is ${want} 확인됨 (레거시 UI, ${lab} 기준).`;

    return { ok: true, detail, clause: "is", verticalToken: want };
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

  /**
   * Vendor group filters 이하 텍스트에 대한 검증 묶음.
   * @param {{ verticalSegment?: string }} [options]
   */
  function validateVendorGroupFilters(iframeText, options) {
    const verticalSegment = normalizeVerticalSegment(options?.verticalSegment);
    const t = iframeText || "";
    if (!t.trim()) {
      return {
        ok: false,
        checks: null,
        detail: "iframe 본문 텍스트가 비어 있습니다.",
        verticalSegment,
      };
    }
    const section = sliceVendorGroupFiltersSection(t);
    if (!section) {
      return {
        ok: false,
        checks: null,
        detail: '화면에 "Vendor group filters" 문구가 없습니다.',
        verticalSegment,
      };
    }

    const blocks = extractValuesBlockContents(section);
    const vendorIds = checkVendorIdsStrict(section, blocks);

    const verticalCheck = checkVerticalTypeStrict(section, blocks, verticalSegment);
    const verticalOk = verticalCheck.ok;
    const verticalDetail = verticalCheck.detail;

    const deliveryCheck = checkDeliveryTypeStrict(section, blocks);
    const deliveryOk = deliveryCheck.ok;
    const deliveryDetail = deliveryCheck.detail;

    const ok = verticalOk && vendorIds.ok && deliveryOk;
    const checks = {
      verticalTypeShop: {
        ok: verticalOk,
        detail: verticalDetail,
        clause: verticalCheck.clause ?? null,
        verticalToken: verticalCheck.verticalToken ?? null,
      },
      vendorIds: {
        ok: vendorIds.ok,
        count: vendorIds.count,
        ids: vendorIds.ids,
        detail: vendorIds.detail,
      },
      deliveryTypesPlatform: {
        ok: deliveryOk,
        detail: deliveryDetail,
        clause: deliveryCheck.clause ?? null,
      },
    };

    const detail = [
      checks.verticalTypeShop.detail,
      checks.vendorIds.detail,
      checks.deliveryTypesPlatform.detail,
    ].join(" | ");

    return { ok, checks, detail, verticalSegment };
  }

  function normalizedHash() {
    const raw = (window.location.hash || "").split("?")[0];
    return (raw.replace(/\/$/, "") || "").toLowerCase();
  }

  function isCommerceExperimentsRoute() {
    if (window.location.hostname !== "portal.woowahan.com") return false;
    const path = (window.location.pathname || "").replace(/\/$/, "") || "/";
    const baseNorm = BASE_PATH.replace(/\/$/, "") || "/";
    const onDps =
      path === baseNorm ||
      path.endsWith("/logistics-dynamic-pricing") ||
      path.includes("/logistics-dynamic-pricing/");
    if (!onDps) return false;
    const h = normalizedHash();
    const p = COMMERCE_HASH_PREFIX.toLowerCase();
    return h === p || h.startsWith(`${p}/`);
  }

  function parseIdInput(str) {
    const ids = [];
    for (const raw of str.split(",").map((s) => s.trim()).filter(Boolean)) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`잘못된 실험 ID: "${raw}" (양의 정수만, 쉼표로 구분)`);
      }
      ids.push(n);
    }
    if (ids.length === 0) throw new Error("실험 ID를 하나 이상 입력하세요.");
    return [...new Set(ids)].sort((a, b) => a - b);
  }

  function readIframeBodyText() {
    const f = document.querySelector("iframe.pluginIframe");
    if (!f) return { ok: false, error: "no iframe.pluginIframe" };
    let d;
    try {
      d = f.contentDocument;
    } catch (e) {
      return { ok: false, error: `cannot access iframe: ${e}` };
    }
    if (!d || !d.body) return { ok: false, error: "no iframe body" };
    return { ok: true, text: d.body.innerText || "" };
  }

  function getIframeLocationHref() {
    const f = document.querySelector("iframe.pluginIframe");
    if (!f?.contentWindow) return "";
    try {
      return f.contentWindow.location.href || "";
    } catch {
      return "";
    }
  }

  function getIframeRouteExperimentId() {
    const href = getIframeLocationHref();
    if (!href) return null;
    const m = href.match(/automatic-assignment\/(\d+)\/edit(?:[?#]|$)/i);
    return m ? m[1] : null;
  }

  /** 최상위 창 전체 URL 에서 automatic-assignment/{id}/edit (해시만이 아니라 pathname 혼용 대비) */
  function getExperimentIdFromTopHash() {
    try {
      const u = window.location.href || "";
      const m = u.match(/automatic-assignment\/(\d+)\/edit(?:[?#]|$)/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function routeAlignedForExperiment(experimentId) {
    const id = String(experimentId);
    return getExperimentIdFromTopHash() === id || getIframeRouteExperimentId() === id;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * MV3 서비스 워커가 잠들면 "Receiving end does not exist" 등 — 짧게 재시도.
   */
  async function sendMessageToBackgroundReliable(message, maxAttempts = 10) {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(message, (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(resp);
          });
        });
        return response;
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || e);
        const transient =
          /Receiving end does not exist|message port closed|Could not establish connection/i.test(
            msg
          );
        if (!transient || attempt === maxAttempts - 1) throw e;
        await sleep(120 * (attempt + 1));
      }
    }
    throw lastErr;
  }

  /**
   * 새 탭 전용: 네비 없이(이미 전체 URL 로 열림) 대기 후 iframe 폴링.
   * 상단 URL 이 이미 해당 실험 edit 이면 iframe location 이 잠깐 null 이어도 본문+Vendor mark 로 진행 (포털 SPA 특성).
   */
  async function pollVendorGroupFiltersInCurrentTab(experimentId, verticalSegment, postLoadMs) {
    const id = String(experimentId);
    const seg = normalizeVerticalSegment(verticalSegment);
    const wait0 =
      typeof postLoadMs === "number" && postLoadMs >= 0 ? postLoadMs : FIRST_POST_LOAD_WAIT_MS;
    await sleep(wait0);

    const deadline = Date.now() + MAX_MS;
    let lastErr = "timeout: iframe edit URL 또는 Vendor group filters 대기";
    while (Date.now() < deadline) {
      const topId = getExperimentIdFromTopHash();
      const iframeId = getIframeRouteExperimentId();

      if (iframeId != null && iframeId !== id) {
        lastErr = `iframe URL 은 실험 ${iframeId} (기대 ${id}), 상단 ${topId ?? "-"}`;
        await sleep(POLL_MS);
        continue;
      }

      const topOk = topId === id;
      const iframeOk = iframeId === id;
      if (!topOk && !iframeOk) {
        lastErr = `라우트 대기 — 상단 ${topId ?? "-"}, iframe ${iframeId ?? "-"}`;
        await sleep(POLL_MS);
        continue;
      }

      const body = readIframeBodyText();
      if (!body.ok) {
        lastErr = body.error || lastErr;
        await sleep(POLL_MS);
        continue;
      }
      if (!VENDOR_GROUP_MARK.test(body.text)) {
        lastErr = 'iframe innerText 에 "Vendor group filters" 가 아직 없습니다';
        await sleep(POLL_MS);
        continue;
      }
      const v = validateVendorGroupFilters(body.text, { verticalSegment: seg });
      return {
        experimentId,
        ok: v.ok,
        detail: v.detail,
        checks: v.checks,
      };
    }
    throw new Error(lastErr);
  }

  let dpsAutoRunConsumed = false;
  let dpsAutoRunLock = false;

  async function tryAutoRunFromQueuedNewTab() {
    if (dpsAutoRunConsumed || dpsAutoRunLock) return;
    if (!chrome.storage?.local || !chrome.runtime?.id) return;

    const { dpsCommerceRunState: state } = await chrome.storage.local.get("dpsCommerceRunState");
    if (!state?.ids?.length || state.index >= state.ids.length) return;
    if (dpsAutoRunConsumed || dpsAutoRunLock) return;

    const expectId = String(state.ids[state.index]);
    dpsAutoRunLock = true;

    try {
      const routeDeadline = Date.now() + ROUTE_ALIGN_WAIT_MS;
      while (Date.now() < routeDeadline) {
        if (routeAlignedForExperiment(expectId)) break;
        await sleep(ROUTE_ALIGN_POLL_MS);
      }

      if (!routeAlignedForExperiment(expectId)) {
        dpsAutoRunConsumed = true;
        try {
          await sendMessageToBackgroundReliable({
            type: "DPS_COMMERCE_STEP_DONE",
            payload: {
              ok: false,
              experimentId: expectId,
              error:
                `실험 ${expectId} edit 라우트 대기 초과: 상단·iframe 중 하나에 automatic-assignment/${expectId}/edit 이 보여야 합니다. (SPA·iframe 지연)`,
            },
          });
        } catch (e) {
          console.warn("[DPS 커머스 검증] STEP_DONE(라우트실패) 전송 실패:", e);
        }
        return;
      }

      dpsAutoRunConsumed = true;

      const seg = normalizeVerticalSegment(state.verticalSegment);
      const postLoadMs = state.index === 0 ? FIRST_POST_LOAD_WAIT_MS : NEXT_POST_LOAD_WAIT_MS;
      try {
        const result = await pollVendorGroupFiltersInCurrentTab(Number(expectId), seg, postLoadMs);
        await sendMessageToBackgroundReliable({
          type: "DPS_COMMERCE_STEP_DONE",
          payload: { ok: true, result },
        });
      } catch (e) {
        const errMsg = String(e.message || e);
        try {
          await sendMessageToBackgroundReliable({
            type: "DPS_COMMERCE_STEP_DONE",
            payload: { ok: false, experimentId: expectId, error: errMsg },
          });
        } catch (e2) {
          console.warn("[DPS 커머스 검증] STEP_DONE(오류) 전송 실패:", e2);
        }
      }
    } finally {
      dpsAutoRunLock = false;
    }
  }

  /** hash·history 변화 후: 같은 탭에서 다음 실험 URL 로 바뀌면 consumed 해제하고 자동 검증 재개 */
  function scheduleCommerceAutoRun() {
    queueMicrotask(() => {
      (async () => {
        if (!dpsAutoRunLock) {
          const { dpsCommerceRunState: state } = await chrome.storage.local.get("dpsCommerceRunState");
          if (state?.ids?.length && state.index < state.ids.length) {
            const exp = String(state.ids[state.index]);
            if (routeAlignedForExperiment(exp)) dpsAutoRunConsumed = false;
          }
        }
        await tryAutoRunFromQueuedNewTab();
      })().catch((err) => {
        console.warn("[DPS 커머스 검증] 자동 검증:", err);
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DPS_COMMERCE_WORKER_NAV") {
      dpsAutoRunConsumed = false;
      scheduleCommerceAutoRun();
      sendResponse({ ok: true });
      return;
    }
  });

  function verticalReportValue(verticalCheck) {
    if (!verticalCheck.ok) return verticalCheck.detail || "NG";
    const tok = verticalCheck.verticalToken;
    if (tok) return tok;
    return "OK";
  }

  /** scripts/vendor-group-filters-logic.mjs `buildVendorGroupFiltersReportText` 와 동일 (동기화 필수) */
  function buildReportText(results, reportOpts) {
    const seg = normalizeVerticalSegment(reportOpts?.verticalSegment);
    const segLine =
      seg === "food"
        ? "(1) Vertical — 푸드 기준: is restaurants"
        : "(1) Vertical — 커머스 기준: is shop";
    const lines = [];
    lines.push("=== 검증 항목 ===");
    lines.push(segLine);
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
    lines.push(
      JSON.stringify(
        {
          verticalSegment: seg,
          results,
          summary: { pass, failRule, failTech, total: results.length },
        },
        null,
        2
      )
    );
    return lines.join("\n");
  }

  function ensureRoot() {
    if (document.getElementById("dps-commerce-validator-root")) return;

    const root = document.createElement("div");
    root.id = "dps-commerce-validator-root";

    const fab = document.createElement("button");
    fab.id = "dps-commerce-validator-fab";
    fab.type = "button";
    fab.textContent = "DPS 커머스 운영안 검증";
    fab.title = `DPS 커머스 운영안 검증 v${VERSION}`;

    const panelWrap = document.createElement("div");
    panelWrap.id = "dps-commerce-validator-panel-wrap";
    panelWrap.setAttribute("role", "dialog");
    panelWrap.setAttribute("aria-label", "DPS 커머스 운영안 검증");

    const panel = document.createElement("div");
    panel.id = "dps-commerce-validator-panel";

    panel.innerHTML = `
      <header>
        <h1>DPS 커머스 운영안 검증 <span style="font-weight:500;color:#6c757d;font-size:13px">v${VERSION}</span></h1>
        <button type="button" class="dps-close" aria-label="닫기">×</button>
      </header>
      <div class="dps-body">
        <p id="dps-commerce-segment-hint" class="dps-segment-hint">
          검증 기준을 고르세요. <strong>커머스</strong>는 Vertical <code>shop</code>, <strong>푸드</strong>는 <code>restaurants</code>만 통과합니다.
        </p>
        <fieldset class="dps-vertical-field" aria-describedby="dps-commerce-segment-hint">
          <legend>푸드 / 커머스 (택 1)</legend>
          <label class="dps-radio-line">
            <input type="radio" name="dps-vertical-segment" value="bmart" checked />
            <span><strong>커머스</strong> (비마트) — Vertical type <code>is shop</code></span>
          </label>
          <label class="dps-radio-line">
            <input type="radio" name="dps-vertical-segment" value="food" />
            <span><strong>푸드</strong> — Vertical type <code>is restaurants</code> (단수 <code>restaurant</code> 미사용)</span>
          </label>
        </fieldset>
        <label class="dps-label" for="dps-commerce-ids-input">실험 ID (쉼표로 구분)</label>
        <textarea id="dps-commerce-ids-input" placeholder="예: 141, 142" spellcheck="false"></textarea>
        <div class="dps-commerce-caution" role="note" aria-label="유의사항">
          <strong>유의사항</strong>
          <p>
            Chrome이 비활성 탭을 절전·스로틀하는 환경에서는, 드물게 로드가 느려질 수 있습니다.
            그때는 <strong>백그라운드 worker 탭</strong>을 한 번만 앞으로 켜 두고 다시 시험해 보세요.
          </p>
        </div>
        <div class="dps-meta">
          <strong>검증 항목 (Vendor Group Filters, iframe innerText)</strong>
          <ul>
            <li><strong>실행 시</strong> 부모 창·iframe 은 건드리지 않고, <strong>백그라운드 탭 하나</strong>에서 첫 실험 edit URL 을 연 뒤(화면 전환 없음), 여러 ID면 <strong>그 탭에서 주소만</strong> 다음 실험으로 바꿉니다(탭이 닫혔을 때만 새 탭). 첫 실험은 약 <strong>7초</strong>·이후 단계는 약 <strong>3.5초</strong> 대기 후 iframe 을 읽습니다. 결과는 <strong>이 탭 패널</strong>에 모입니다.</li>
            <li><strong>Clause/Values UI</strong>: 첫 숫자-only <code>Values</code> 블록 → vendor id <strong>개수·목록</strong></li>
            <li>위에서 고른 <strong>푸드 / 커머스</strong>에 맞춰 Vertical <code>Values</code>가 <strong>shop</strong>(커머스) 또는 <strong>restaurants</strong>(푸드)인지, <strong>is / is not</strong> 판별</li>
            <li>Delivery: <strong>is PLATFORM_DELIVERY</strong> (is not 이면 NG)</li>
          </ul>
        </div>
        <div class="dps-actions">
          <button type="button" id="dps-commerce-run">실행</button>
        </div>
        <div id="dps-commerce-complete-banner" class="dps-complete">검증이 완료되었습니다.</div>
        <div id="dps-commerce-results"></div>
      </div>
    `;

    const closeBtn = panel.querySelector(".dps-close");
    const runBtn = panel.querySelector("#dps-commerce-run");
    const input = panel.querySelector("#dps-commerce-ids-input");
    const resultsEl = panel.querySelector("#dps-commerce-results");
    const completeBanner = panel.querySelector("#dps-commerce-complete-banner");
    const verticalRadios = panel.querySelectorAll('input[name="dps-vertical-segment"]');

    function readSelectedVerticalSegment() {
      for (const r of verticalRadios) {
        if (r.checked) return normalizeVerticalSegment(r.value);
      }
      return "bmart";
    }

    function persistVerticalSegment(seg) {
      try {
        localStorage.setItem(STORAGE_VERTICAL, normalizeVerticalSegment(seg));
      } catch {
        /* quota / private mode */
      }
    }

    try {
      const saved = localStorage.getItem(STORAGE_VERTICAL);
      if (saved === "food" || saved === "bmart") {
        for (const r of verticalRadios) {
          r.checked = r.value === saved;
        }
      }
    } catch {
      /* ignore */
    }

    for (const r of verticalRadios) {
      r.addEventListener("change", () => {
        if (r.checked) persistVerticalSegment(r.value);
      });
    }

    function openPanel() {
      if (!isCommerceExperimentsRoute()) {
        alert(
          "DPS 커머스 운영안 화면에서만 사용할 수 있습니다.\n\n" +
            `예: ${ORIGIN}${BASE_PATH}${COMMERCE_HASH_PREFIX}\n` +
            `또는 ${ORIGIN}${BASE_PATH}#/automatic-assignment/… (하위 경로 포함)`
        );
        return;
      }
      panelWrap.classList.add("dps-open");
      input.focus();
    }

    function closePanel() {
      panelWrap.classList.remove("dps-open");
    }

    fab.addEventListener("click", openPanel);
    closeBtn.addEventListener("click", closePanel);

    runBtn.addEventListener("click", async () => {
      resultsEl.classList.remove("dps-visible");
      resultsEl.textContent = "";
      completeBanner.classList.remove("dps-visible");
      const oldErr = panel.querySelector(".dps-err");
      if (oldErr) oldErr.remove();

      let ids;
      try {
        ids = parseIdInput(input.value);
      } catch (e) {
        const p = document.createElement("p");
        p.className = "dps-err";
        p.textContent = String(e.message || e);
        panel.querySelector(".dps-actions").after(p);
        return;
      }

      if (!chrome.runtime?.id) {
        const p = document.createElement("p");
        p.className = "dps-err";
        p.textContent = "확장 프로그램 컨텍스트를 사용할 수 없습니다. 페이지를 새로고침하거나 확장을 다시 로드하세요.";
        panel.querySelector(".dps-actions").after(p);
        return;
      }

      runBtn.disabled = true;
      runBtn.textContent = "백그라운드 탭…";
      let succeeded = false;

      const verticalSegment = readSelectedVerticalSegment();
      persistVerticalSegment(verticalSegment);

      await chrome.storage.local.remove(["dpsCommerceFinalResults"]);

      let storageListener = null;
      let waitTimer = null;

      const cleanupWait = () => {
        if (storageListener) {
          chrome.storage.onChanged.removeListener(storageListener);
          storageListener = null;
        }
        if (waitTimer != null) {
          clearTimeout(waitTimer);
          waitTimer = null;
        }
      };

      const finishWithError = (msg) => {
        cleanupWait();
        const p = document.createElement("p");
        p.className = "dps-err";
        p.textContent = msg;
        panel.querySelector(".dps-actions").after(p);
        runBtn.disabled = false;
        runBtn.textContent = "실행";
        syncFabVisibility();
      };

      try {
        const startResp = await sendMessageToBackgroundReliable({
          type: "DPS_COMMERCE_START_RUN",
          ids,
          verticalSegment,
        });
        if (!startResp?.ok) {
          throw new Error(startResp?.error || "새 탭을 열지 못했습니다.");
        }

        runBtn.textContent = "검증 중(백그라운드)…";

        const fin = await new Promise((resolve, reject) => {
          waitTimer = setTimeout(() => {
            cleanupWait();
            reject(new Error("결과 대기 시간이 초과되었습니다. 백그라운드 worker 탭이 열렸는지 확인하세요."));
          }, OPENER_WAIT_TOTAL_MS);

          storageListener = (changes, area) => {
            if (area !== "local" || !changes.dpsCommerceFinalResults) return;
            const next = changes.dpsCommerceFinalResults.newValue;
            if (!next || !Array.isArray(next.results)) return;
            cleanupWait();
            resolve(next);
          };
          chrome.storage.onChanged.addListener(storageListener);
        });

        const pre = document.createElement("pre");
        let text = buildReportText(fin.results, { verticalSegment: fin.verticalSegment });
        if (fin.runError) {
          text += `\n\n(경고: ${fin.runError})`;
        }
        pre.textContent = text;
        resultsEl.appendChild(pre);
        resultsEl.classList.add("dps-visible");
        succeeded = true;
      } catch (e) {
        finishWithError(String(e.message || e));
      } finally {
        if (storageListener) cleanupWait();
        runBtn.disabled = false;
        runBtn.textContent = "실행";
        if (succeeded) completeBanner.classList.add("dps-visible");
        syncFabVisibility();
      }
    });

    panelWrap.appendChild(panel);
    root.appendChild(fab);
    root.appendChild(panelWrap);
    const mountParent = document.body || document.documentElement;
    mountParent.appendChild(root);

    function syncFabVisibility() {
      fab.style.display = isCommerceExperimentsRoute() ? "block" : "none";
    }

    function scheduleTryAutoRun() {
      scheduleCommerceAutoRun();
    }

    function onUserNavigation() {
      syncFabVisibility();
      scheduleTryAutoRun();
      if (!isCommerceExperimentsRoute() && panelWrap.classList.contains("dps-open")) closePanel();
    }

    syncFabVisibility();
    window.addEventListener("hashchange", onUserNavigation);
    window.addEventListener("popstate", onUserNavigation);

    function hookHistoryForFabSync() {
      try {
        const notify = () =>
          queueMicrotask(() => {
            syncFabVisibility();
            scheduleCommerceAutoRun();
          });
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        if (typeof origPush !== "function" || typeof origReplace !== "function") return;
        history.pushState = function (...args) {
          const ret = origPush.apply(this, args);
          notify();
          return ret;
        };
        history.replaceState = function (...args) {
          const ret = origReplace.apply(this, args);
          notify();
          return ret;
        };
      } catch (e) {
        console.warn("[DPS 커머스 검증] history 후킹 생략:", e);
      }
    }
    hookHistoryForFabSync();

    setInterval(syncFabVisibility, 400);
    setTimeout(syncFabVisibility, 50);
    setTimeout(syncFabVisibility, 500);
    setTimeout(syncFabVisibility, 2000);
  }

  try {
    ensureRoot();
    scheduleCommerceAutoRun();
  } catch (e) {
    console.error("[DPS 커머스 검증] 초기화 실패:", e);
  }
})();
