(() => {
  /**
   * 접속·리프레시 정책 (레포 scripts/run-vendor-group-cdp.mjs 와 동일 취지)
   *
   * - 매 실험마다 상단 주소를 먼저 목록(#/automatic-assignment)으로 맞춘 뒤 iframe 도 목록으로 replace,
   *   iframe 해시가 실제로 목록인지 폴링(LIST_ROUTE_WAIT_MS) — 고정 sleep 만으로는 SPA 가 전환 안 하는 경우가 있음.
   *   목록 진입 실패 시 about:blank 로 문서를 비운 뒤 목록→edit 재시도.
   * - 목록 확인 후 syncTopLocationToEdit + iframe contentWindow.location.replace(edit) 만 (src/reload 없음).
   * - edit URL 일치 후 innerText 에 Vendor group filters 가 보일 때까지 폴링.
   * - 배치 시 실험 사이 BETWEEN_EXPERIMENTS_MS 간격.
   */
  const VERSION = "0.5.0";
  const POLL_MS = 600;
  const MAX_MS = 45000;
  const NAV_SETTLE_MS = 400;
  /** iframe 이 #/automatic-assignment 로 바뀔 때까지 최대 대기 */
  const LIST_ROUTE_WAIT_MS = 10000;
  const LIST_ROUTE_POLL_MS = 80;
  /** 목록 라우트 확인 후 edit 로 넘어가기 전 짧은 안정화 */
  const LIST_STABILIZE_MS = 120;
  const BETWEEN_EXPERIMENTS_MS = 700;
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

  function iframeShowsExperiment(experimentId) {
    return getIframeRouteExperimentId() === String(experimentId);
  }

  function iframeHashNormalized() {
    const href = getIframeLocationHref();
    if (!href) return "";
    try {
      const u = new URL(href);
      return (u.hash || "").split("?")[0].replace(/\/$/, "").toLowerCase();
    } catch {
      return "";
    }
  }

  /** iframe 해시가 정확히 automatic-assignment 목록(하위 /id/edit 없음)인지 */
  function iframeIsCommerceListRoute() {
    const base = COMMERCE_HASH_PREFIX.replace(/\/$/, "").toLowerCase();
    return iframeHashNormalized() === base;
  }

  function syncTopLocationToList() {
    const hash = COMMERCE_HASH_PREFIX;
    const path = window.location.pathname.split("?")[0];
    const next = `${window.location.origin}${path}${hash}`;
    try {
      history.replaceState(null, "", next);
    } catch {
      window.location.hash = hash;
    }
  }

  async function waitUntilIframeListOrTimeout() {
    const deadline = Date.now() + LIST_ROUTE_WAIT_MS;
    while (Date.now() < deadline) {
      if (iframeIsCommerceListRoute()) return true;
      await sleep(LIST_ROUTE_POLL_MS);
    }
    return false;
  }

  /** 상단 edit 해시 + iframe replace(edit) 만 (v0.5 — src/reload 없음) */
  function navIframeToExperimentEditReplace(f, experimentId) {
    const id = String(experimentId);
    const editUrl = `${ORIGIN}${BASE_PATH}#/automatic-assignment/${id}/edit`;
    syncTopLocationToEdit(id);
    try {
      f.contentWindow.location.replace(editUrl);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `iframe edit nav: ${e}` };
    }
  }

  /**
   * 목록 replace 가 SPA 에서 무시될 때: iframe 문서를 비운 뒤 목록→edit 재진입.
   */
  async function hardResetIframeNavToListThenEdit(experimentId) {
    const id = String(experimentId);
    const f = document.querySelector("iframe.pluginIframe");
    if (!f?.contentWindow) return { ok: false, error: "no iframe.pluginIframe" };
    const listUrl = `${ORIGIN}${BASE_PATH}${COMMERCE_HASH_PREFIX}`;
    try {
      syncTopLocationToList();
      f.contentWindow.location.replace("about:blank");
      const blankDeadline = Date.now() + 5000;
      while (Date.now() < blankDeadline) {
        try {
          if (f.contentWindow.location.href.startsWith("about:blank")) break;
        } catch {
          /* navigation in progress */
        }
        await sleep(50);
      }
      await sleep(80);
      f.contentWindow.location.replace(listUrl);
      const okList = await waitUntilIframeListOrTimeout();
      if (!okList) {
        return {
          ok: false,
          error:
            "iframe 이 목록(#/automatic-assignment)으로 바뀌지 않습니다. about:blank 리셋 후에도 동일하면 포털·네트워크를 확인하세요.",
        };
      }
      await sleep(LIST_STABILIZE_MS);
      return navIframeToExperimentEditReplace(f, id);
    } catch (e) {
      return { ok: false, error: `hard iframe reset: ${e}` };
    }
  }

  /**
   * 상단·iframe 모두 목록으로 동기화 → iframe 해시가 목록인지 확인 → 상단·iframe edit.
   * (상단을 먼저 edit 으로만 맞추면 호스트가 iframe 을 덮어써 replace 가 무시되는 경우가 있어 순서 조정.)
   */
  async function navIframeListThenEdit(experimentId) {
    const id = String(experimentId);
    const f = document.querySelector("iframe.pluginIframe");
    if (!f || !f.contentWindow) return { ok: false, error: "no iframe.pluginIframe" };
    const listUrl = `${ORIGIN}${BASE_PATH}${COMMERCE_HASH_PREFIX}`;
    try {
      syncTopLocationToList();
      f.contentWindow.location.replace(listUrl);
      let okList = await waitUntilIframeListOrTimeout();
      if (!okList) {
        return await hardResetIframeNavToListThenEdit(id);
      }
      await sleep(LIST_STABILIZE_MS);
      return navIframeToExperimentEditReplace(f, id);
    } catch (e) {
      return { ok: false, error: `iframe nav: ${e}` };
    }
  }

  function syncTopLocationToEdit(experimentId) {
    const id = String(experimentId);
    const hash = `#/automatic-assignment/${id}/edit`;
    const path = window.location.pathname.split("?")[0];
    const next = `${window.location.origin}${path}${hash}`;
    try {
      history.replaceState(null, "", next);
    } catch {
      window.location.hash = hash;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function runVendorGroupFiltersCheckForExperiment(experimentId, verticalSegment) {
    const id = String(experimentId);
    const navR = await navIframeListThenEdit(id);
    if (!navR.ok) throw new Error(navR.error);

    await sleep(NAV_SETTLE_MS);

    const deadline = Date.now() + MAX_MS;
    let lastErr = "timeout: iframe edit URL 또는 Vendor group filters 대기";
    while (Date.now() < deadline) {
      if (!iframeShowsExperiment(experimentId)) {
        const cur = getIframeRouteExperimentId();
        lastErr =
          cur == null
            ? "iframe route not on experiment edit yet"
            : `iframe still on experiment ${cur}, waiting for ${id}`;
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
      const v = validateVendorGroupFilters(body.text, { verticalSegment });
      return {
        experimentId,
        ok: v.ok,
        detail: v.detail,
        checks: v.checks,
      };
    }
    throw new Error(lastErr);
  }

  async function runBatch(ids, verticalSegment) {
    /** @type {object[]} */
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const experimentId = ids[i];
      if (i > 0) await sleep(BETWEEN_EXPERIMENTS_MS);
      try {
        out.push(await runVendorGroupFiltersCheckForExperiment(experimentId, verticalSegment));
      } catch (e) {
        out.push({ experimentId, error: String(e.message || e) });
      }
    }
    return out;
  }

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
        <div class="dps-meta">
          <strong>검증 항목 (Vendor Group Filters, iframe innerText)</strong>
          <ul>
            <li><strong>실행 시</strong> 입력한 실험마다 iframe 을 목록(<code>#/automatic-assignment</code>)으로 보낸 뒤 해당 <code>…/edit</code> 로 열어, 항상 그 실험 화면을 읽습니다.</li>
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

      runBtn.disabled = true;
      runBtn.textContent = "실행 중…";
      let succeeded = false;
      try {
        const verticalSegment = readSelectedVerticalSegment();
        persistVerticalSegment(verticalSegment);
        const batchResults = await runBatch(ids, verticalSegment);
        const pre = document.createElement("pre");
        pre.textContent = buildReportText(batchResults, { verticalSegment });
        resultsEl.appendChild(pre);
        resultsEl.classList.add("dps-visible");
        succeeded = true;
      } catch (e) {
        const p = document.createElement("p");
        p.className = "dps-err";
        p.textContent = String(e.message || e);
        panel.querySelector(".dps-actions").after(p);
      } finally {
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

    function onUserNavigation() {
      syncFabVisibility();
      if (!isCommerceExperimentsRoute() && panelWrap.classList.contains("dps-open")) closePanel();
    }

    syncFabVisibility();
    window.addEventListener("hashchange", onUserNavigation);
    window.addEventListener("popstate", onUserNavigation);

    function hookHistoryForFabSync() {
      try {
        const notify = () => queueMicrotask(() => syncFabVisibility());
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
  } catch (e) {
    console.error("[DPS 커머스 검증] 초기화 실패:", e);
  }
})();
