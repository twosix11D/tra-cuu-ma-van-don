// Tracking lookup library for the Vercel deployment of Tra cứu mã vận đơn.
//
// Ported 1:1 from the Muse artifact's server actions
// (server/src/actions.ts). Data sources, in priority order (user decision
// 2026-11-12: "Làm full bằng API (17TRACK + API GHTK)"):
// 1. GHTK-format codes -> GHTK's official API
//    (GET https://services.giaohangtietkiem.vn/services/shipment/v2/{code},
//    header `Token` + `X-Client-Source`).
// 2. Every other code -> 17TRACK Tracking API v2.4
//    (POST https://api.17track.net/track/v2.4/gettrackinfo, header
//    `17token`; numbers are registered on first sight via /register).
// 3. Fallback: per-carrier direct adapters over each carrier's public
//    tracking page (SPX with a remembered 60-minute anti-bot cooldown,
//    GHN phone verification, VNPost captcha, bot walls elsewhere — all
//    reported honestly, never circumvented. GHTK has a public page
//    (i.ghtk.vn) but each lookup needs a browser-minted reCAPTCHA token,
//    so the server links one-tap to i.ghtk.vn/<code> instead of fetching
//    it (see fetchGhtkDirect). SPX only: the primary path is
//    now the get_order_info endpoint (see fetchSpxOrderInfo), which answers
//    with the full journey and no key from datacenter IPs; when
//    LASTSCANNED_API_KEY is set, SPX codes are also tried through the
//    LastScanned tracking API (from the Termux app Long sent,
//    spx-tracking-pro) if get_order_info has no answer; without a key that
//    adapter is skipped, because LastScanned refuses keyless lookups from
//    cloud/hosting networks (HTTP 402, verified 2026-11-13).
//
// Credentials are read from the server process environment ONLY
// (TRACK17_API_KEY, GHTK_API_TOKEN, GHTK_CLIENT_SOURCE,
// LASTSCANNED_API_KEY — set them in the Vercel project's Environment
// Variables). They never reach the browser:
// the API routes expose only booleans about whether each key is set.
// When a key is missing, lookups that need it return an explicit
// `not_configured` state in Vietnamese instead of fake data.
//
// One serverless adaptation: the SPX anti-bot cooldown is kept in module
// memory instead of the artifact's database. It is therefore per
// function instance (best-effort), but the behavior — stop calling SPX
// for 60 minutes after a block and say so — is unchanged.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Vietnamese labels for the normalized main statuses (same vocabulary the
// client already renders; identical to 17TRACK's 9 main statuses).
// ---------------------------------------------------------------------------

const STATUS_VI: Record<string, string> = {
  NotFound: "Chưa có thông tin",
  InfoReceived: "Đã tiếp nhận thông tin đơn",
  InTransit: "Đang vận chuyển",
  Expired: "Quá hạn vận chuyển",
  AvailableForPickup: "Đã đến điểm nhận hàng",
  OutForDelivery: "Đang giao hàng",
  DeliveryFailure: "Giao hàng không thành công",
  Delivered: "Đã giao thành công",
  Exception: "Có sự cố phát sinh",
};

function statusLabel(status: string): string {
  return STATUS_VI[status] ?? status;
}

// ---------------------------------------------------------------------------
// Shared zod shapes
// ---------------------------------------------------------------------------

export type TrackingEvent = {
  time: string | null;
  description: string;
  location: string | null;
};

export type TrackingResult = {
  number: string;
  carrierKey: number | null;
  carrierName: string | null;
  status: string;
  statusLabel: string;
  latestEvent: string | null;
  latestEventTime: string | null;
  estimatedDelivery: string | null;
  originCountry: string | null;
  destinationCountry: string | null;
  events: TrackingEvent[];
  /**
   * GHN phone_verify hash (sha256 of "CODE|phone"), set only when a GHN
   * lookup succeeded with phone verification. The client stores it on
   * its own device so a later refresh can reuse it without asking for
   * the phone number again. Never the raw phone number.
   */
  phoneVerify?: string | null;
};

// ---------------------------------------------------------------------------
// API configuration (server-side credentials, via the privileged channel)
// ---------------------------------------------------------------------------

export type ApiConfig = {
  track17ApiKey: string | null;
  ghtkApiToken: string | null;
  ghtkClientSource: string | null;
  lastScannedApiKey: string | null;
};


export function getApiConfig(): ApiConfig {
  const read = (name: string): string | null => {
    const value = process.env[name]?.trim();
    return value ? value : null;
  };
  return {
    track17ApiKey: read("TRACK17_API_KEY"),
    ghtkApiToken: read("GHTK_API_TOKEN"),
    ghtkClientSource: read("GHTK_CLIENT_SOURCE"),
    lastScannedApiKey: read("LASTSCANNED_API_KEY"),
  };
}

// ---------------------------------------------------------------------------
// Defensive JSON helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Time normalization: carrier payloads use ISO, "yyyy-mm-dd hh:mm:ss"
// (Vietnam local time) or "dd/mm/yyyy hh:mm". Everything is stored as an
// ISO instant; Vietnam-local wall times are pinned to +07:00.
// ---------------------------------------------------------------------------

function pad2(n: string): string {
  return n.padStart(2, "0");
}

function normalizeTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "") return null;

  const dmy = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (dmy) {
    const [, dd = "1", mm = "1", yyyy = "1970", hh = "0", mi = "0", ss = "0"] =
      dmy;
    const d = new Date(
      `${yyyy}-${pad2(mm)}-${pad2(dd)}T${pad2(hh)}:${mi}:${ss}+07:00`,
    );
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const ymdLocal = s.match(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/);
  if (ymdLocal) {
    const d = new Date(`${s.replace(" ", "T")}+07:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Generic event extraction: carriers return wildly different JSON shapes,
// so find the largest array of records that carry both a description-ish
// and a time-ish field, and normalize those records into timeline events.
// (Used by the direct fallback adapters; the API adapters parse their
// documented shapes explicitly.)
// ---------------------------------------------------------------------------

const TEXT_KEY = /desc|status|content|detail|event|title|action|remark|trang|activity/i;
const TIME_KEY = /time|date|ngay|gio/i;
const LOC_KEY = /location|address|place|hub|station|depot|noi|dia|province|city|facility/i;

function locationText(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  const rec = asRecord(value);
  if (!rec) return null;
  for (const v of Object.values(rec)) {
    const s = asString(v);
    if (s) return s;
  }
  return null;
}

function eventFromRecord(rec: Record<string, unknown>): TrackingEvent | null {
  let description: string | null = null;
  let timeRaw: unknown = null;
  let location: string | null = null;
  for (const [key, value] of Object.entries(rec)) {
    if (description == null && typeof value === "string" && TEXT_KEY.test(key)) {
      const s = asString(value);
      if (s) description = s;
    } else if (
      timeRaw == null &&
      (typeof value === "string" || typeof value === "number") &&
      TIME_KEY.test(key)
    ) {
      timeRaw = value;
    } else if (location == null && LOC_KEY.test(key)) {
      location = locationText(value);
    }
  }
  if (!description) return null;
  return { time: normalizeTime(timeRaw), description, location };
}

function sortEvents(events: TrackingEvent[]): TrackingEvent[] {
  const seen = new Set<string>();
  const unique = events.filter((e) => {
    const key = `${e.time ?? ""}|${e.description}|${e.location ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => {
    if (a.time && b.time) return b.time.localeCompare(a.time);
    if (a.time) return -1;
    if (b.time) return 1;
    return 0;
  });
  return unique;
}

function extractEvents(root: unknown): TrackingEvent[] {
  let best: TrackingEvent[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      const events = node.flatMap((item) => {
        const rec = asRecord(item);
        if (!rec) return [];
        const event = eventFromRecord(rec);
        return event ? [event] : [];
      });
      if (events.length > best.length) best = events;
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) {
        visit(v, depth + 1);
      }
    }
  };
  visit(root, 0);
  return sortEvents(best);
}

const STATUS_TEXT_KEY =
  /^(status|current_status|order_status|trang_thai|status_text|status_name|statusname|orderstatus)$/i;

function findStatusText(root: unknown): string | null {
  let found: string | null = null;
  const visit = (node: unknown, depth: number): void => {
    if (found != null || depth > 5 || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        const s = asString(value);
        if (s && STATUS_TEXT_KEY.test(key)) {
          found = s;
          return;
        }
        visit(value, depth + 1);
        if (found != null) return;
      }
    }
  };
  visit(root, 0);
  return found;
}

// ---------------------------------------------------------------------------
// Status classification from a carrier's own status/event wording
// (Vietnamese first, English second).
// ---------------------------------------------------------------------------

function classifyStatus(text: string | null): string {
  if (!text) return "InTransit";
  const t = text.toLowerCase();
  if (/đã giao|giao thành công|giao hàng thành công|phát thành công|delivered/.test(t)) {
    return "Delivered";
  }
  if (/đang giao|đang phát|sắp giao|out for delivery/.test(t)) {
    return "OutForDelivery";
  }
  if (
    /giao.*(không thành công|thất bại)|không giao được|phát không thành công|không liên lạc được|delivery failure|failed/.test(t)
  ) {
    return "DeliveryFailure";
  }
  if (/điểm nhận|điểm lấy hàng|chờ lấy tại|available for pickup/.test(t)) {
    return "AvailableForPickup";
  }
  if (/hoàn hàng|trả hàng|hoàn về|sự cố|exception/.test(t)) {
    return "Exception";
  }
  if (/hết hạn|quá hạn|expired/.test(t)) {
    return "Expired";
  }
  if (/tiếp nhận|nhận thông tin|tạo đơn|đã lấy hàng|lấy hàng thành công|nhập kho|info received/.test(t)) {
    return "InfoReceived";
  }
  return "InTransit";
}

// ISO 3166-1 alpha-2 → Vietnamese display name for the most common
// origin/destination countries 17TRACK reports; anything else is shown
// as the raw code the API returned.
const COUNTRY_VI: Record<string, string> = {
  VN: "Việt Nam",
  CN: "Trung Quốc",
  HK: "Hồng Kông",
  TW: "Đài Loan",
  JP: "Nhật Bản",
  KR: "Hàn Quốc",
  SG: "Singapore",
  TH: "Thái Lan",
  MY: "Malaysia",
  ID: "Indonesia",
  PH: "Philippines",
  US: "Hoa Kỳ",
  GB: "Anh",
  DE: "Đức",
  FR: "Pháp",
  NL: "Hà Lan",
  AU: "Úc",
  CA: "Canada",
  IN: "Ấn Độ",
  AE: "UAE",
  RU: "Nga",
};

function countryName(code: string | null): string | null {
  if (!code) return null;
  return COUNTRY_VI[code.toUpperCase()] ?? code;
}

// ---------------------------------------------------------------------------
// HTTP plumbing for the direct fallback adapters: fetch a carrier's
// public endpoint the way its own tracking page does (browser headers,
// no credentials).
// ---------------------------------------------------------------------------

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
};

type FetchOutcome =
  | { kind: "json"; json: unknown; status: number }
  | { kind: "html"; status: number; text: string }
  | { kind: "network" };

async function fetchCarrier(
  url: string,
  init?: RequestInit,
  timeoutMs = 15000,
): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { ...BROWSER_HEADERS, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return { kind: "json", json: JSON.parse(text) as unknown, status: res.status };
    } catch {
      return { kind: "html", status: res.status, text };
    }
  } catch {
    return { kind: "network" };
  }
}

// ---------------------------------------------------------------------------
// Direct fallback carrier adapters
// ---------------------------------------------------------------------------

type AdapterResult =
  | {
      kind: "ok";
      statusText: string | null;
      events: TrackingEvent[];
      estimatedDelivery: string | null;
      phoneVerify?: string | null;
    }
  | { kind: "not_found" }
  | { kind: "blocked"; reason: string; specific?: boolean }
  | { kind: "phone_required"; reason: string };

type AdapterContext = {
  /** LastScanned API key for the SPX adapter (null = adapter skipped). */
  lastScannedApiKey: string | null;
  /**
   * GHN verification credential supplied by the user for this lookup:
   * either the full recipient/sender phone number (hashed server-side)
   * or a 64-hex phone_verify token from an earlier verified lookup.
   * Never stored or logged; lives only in this request.
   */
  ghnCredential: string | null;
};

type CarrierDef = {
  id: string;
  name: string;
  /**
   * Official public tracking page (verified by a live fetch). May be a
   * function building a one-tap link with the code already in the URL
   * (e.g. GHTK's i.ghtk.vn/<code>).
   */
  url: string | null | ((number: string) => string | null);
  detect: (number: string) => boolean;
  fetchTracking: (
    number: string,
    ctx?: AdapterContext,
  ) => Promise<AdapterResult>;
};

function resolveCarrierUrl(
  carrier: CarrierDef,
  number: string,
): string | null {
  return typeof carrier.url === "function"
    ? carrier.url(number)
    : carrier.url;
}

function blockedReason(name: string): string {
  return `${name} đang chặn lấy dữ liệu tự động (kiểm tra bot/captcha) hoặc vừa đổi cấu trúc trang tra cứu nên tạm thời chưa tra tự động được. Các hãng khác vẫn tra bình thường — bạn có thể tra mã này trực tiếp trên trang của ${name}.`;
}

// --- SPX (Shopee Express): public JSON endpoint, verified live. ---------
// This is the FALLBACK SPX path now: the primary path is fetchSpxOrderInfo
// (get_order_info, no key, works from datacenters). This older endpoint
// answers `retcode: 0` with the parcel in `data` (empty object when the
// code is unknown). Shopee's edge also intermittently answers HTTP 403
// with an anti-bot JSON body ({error: 90309999, redirect_to_error_page:
// true, ...} and no `data` at all) — that is a block, NOT a "not found",
// so it is classified separately and retried once before giving up.
//
// Cooldown: once the anti-bot block is observed, the block is remembered
// in `carrier_blocks` for SPX_COOLDOWN_MS and SPX is not called at all
// during that window — hammering a flagged endpoint only deepens the
// flag. Lookups in the window return the honest blocked state right away
// (with the remaining minutes); the first lookup after the window calls
// SPX live again, and any real answer (found or not-found) clears the
// remembered block.
const SPX_COOLDOWN_MS = 60 * 60 * 1000;

let spxBlockedUntilMs = 0;

async function spxCooldownRemainingMs(): Promise<number> {
  return Math.max(0, spxBlockedUntilMs - Date.now());
}

async function rememberSpxBlock(): Promise<void> {
  spxBlockedUntilMs = Date.now() + SPX_COOLDOWN_MS;
}

async function clearSpxBlock(): Promise<void> {
  spxBlockedUntilMs = 0;
}

function spxCooldownReason(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  return `SPX (Shopee Express) đang chặn lấy dữ liệu tự động bằng kiểm tra bảo mật của Shopee. Web đang tạm nghỉ gọi sang SPX khoảng ${minutes} phút nữa để tránh bị chặn nặng thêm, sau đó sẽ tự thử tra lại — bạn có thể tra mã này ngay trên trang của SPX nhé. Các hãng khác vẫn tra bình thường tại đây.`;
}

async function fetchSpx(number: string): Promise<AdapterResult> {
  const remaining = await spxCooldownRemainingMs();
  if (remaining > 0) {
    return { kind: "blocked", specific: true, reason: spxCooldownReason(remaining) };
  }
  const url = `https://spx.vn/api/v2/fleet_order/tracking/search?sls_tracking_number=${encodeURIComponent(number)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    const outcome = await fetchCarrier(url, {
      headers: { Accept: "application/json", Referer: "https://spx.vn/track" },
    });
    if (outcome.kind === "network") {
      return {
        kind: "blocked",
        reason:
          "Không kết nối được tới trang tra cứu của SPX lúc này. Thử lại sau ít phút.",
      };
    }
    if (outcome.kind !== "json") {
      if (attempt === 0) continue;
      await rememberSpxBlock();
      return {
        kind: "blocked",
        specific: true,
        reason: spxCooldownReason(SPX_COOLDOWN_MS),
      };
    }
    const root = asRecord(outcome.json);
    if (!root) return { kind: "blocked", reason: blockedReason("SPX") };
    const isAntiBot =
      outcome.status === 403 ||
      root.redirect_to_error_page === true ||
      (root.error != null && root.data == null);
    if (isAntiBot) {
      if (attempt === 0) continue;
      await rememberSpxBlock();
      return {
        kind: "blocked",
        specific: true,
        reason: spxCooldownReason(SPX_COOLDOWN_MS),
      };
    }
    // SPX answered for real — any remembered block no longer applies.
    await clearSpxBlock();
    const data = asRecord(root.data);
    if (!data || Object.keys(data).length === 0) return { kind: "not_found" };
    const events = extractEvents(data);
    const statusText = findStatusText(data);
    if (events.length === 0 && !statusText) return { kind: "not_found" };
    return { kind: "ok", statusText, events, estimatedDelivery: null };
  }
  return { kind: "blocked", reason: blockedReason("SPX") };
}

// --- SPX via LastScanned (third-party tracking API) -----------------------
// The Termux app Long sent (spx-tracking-pro) tracks SPX through
// LastScanned: GET https://api.lastscanned.com/v1/track/{number}?carrier=spxvn
// with an optional `Authorization: Bearer <key>` header.
// Verified 2026-11-13: keyless lookups are REFUSED from cloud/hosting
// networks (HTTP 402 "Keyless free lookups aren't given to requests from
// cloud or hosting networks") — so on Vercel this adapter only runs when
// LASTSCANNED_API_KEY is set (free account: 5 lookups/day; Pro $4.99/mo:
// 1,000 numbers). Without a key it is skipped entirely and the direct SPX
// adapter runs as before. It is tried BEFORE the direct SPX page because
// Shopee's endpoint blocks datacenter IPs with its anti-bot check.
// Response shape (per the Termux app's normalize()): { trackingNumber,
// status, statusDescription, deliveredAtLocal|deliveredAt, events: [{
// localTime|timestamp, status, description|statusDescription, location }] }.
async function fetchLastScannedSpx(
  number: string,
  apiKey: string,
): Promise<AdapterResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const outcome = await fetchCarrier(
    `https://api.lastscanned.com/v1/track/${encodeURIComponent(number)}?carrier=spxvn`,
    { headers },
  );
  if (outcome.kind === "network") {
    return {
      kind: "blocked",
      reason:
        "Không kết nối được tới LastScanned lúc này. Thử lại sau ít phút.",
    };
  }
  if (outcome.kind !== "json") {
    return { kind: "not_found" };
  }
  if (outcome.status === 401 || outcome.status === 403) {
    return {
      kind: "blocked",
      specific: true,
      reason:
        "LastScanned từ chối key API trên máy chủ (key sai, hết hạn hoặc thiếu quyền). Người quản trị kiểm tra lại biến LASTSCANNED_API_KEY trong cấu hình máy chủ.",
    };
  }
  if (outcome.status === 402) {
    return {
      kind: "blocked",
      specific: true,
      reason:
        "LastScanned yêu cầu thanh toán hoặc key có trả phí cho lượt tra này (gói miễn phí đã hết lượt trong ngày). Người quản trị kiểm tra lại gói LastScanned hoặc dùng key 17TRACK.",
    };
  }
  if (outcome.status === 429) {
    return {
      kind: "blocked",
      specific: true,
      reason:
        "Đã chạm giới hạn lượt tra cứu của LastScanned trong ngày. Thử lại sau hoặc dùng key 17TRACK.",
    };
  }
  const root = asRecord(outcome.json);
  if (!root || outcome.status >= 400) {
    return { kind: "not_found" };
  }
  const rawEvents = Array.isArray(root.events) ? root.events : [];
  const events: TrackingEvent[] = rawEvents
    .map((e) => {
      const rec = asRecord(e);
      if (!rec) return null;
      const description =
        asString(rec.description) ??
        asString(rec.statusDescription) ??
        asString(rec.status);
      if (!description) return null;
      return {
        time: normalizeTime(rec.localTime ?? rec.timestamp),
        description,
        location: asString(rec.location),
      };
    })
    .filter((e): e is TrackingEvent => e !== null);
  const statusText =
    asString(root.statusDescription) ?? asString(root.status);
  if (events.length === 0 && !statusText) return { kind: "not_found" };
  return {
    kind: "ok",
    statusText,
    events,
    estimatedDelivery: normalizeTime(
      root.deliveredAtLocal ?? root.deliveredAt,
    ),
  };
}

// --- SPX via get_order_info (primary SPX path) ---------------------------
// Found in github.com/naminc/spx-tracking-bot (SpxService): the "open
// order info" endpoint the SPX tracking page uses —
// GET https://spx.vn/shipment/order/open/order/get_order_info
//   ?spx_tn={number}&language_code=vi
// with headers Accept: application/json, Referer: https://spx.vn/track?…,
// User-Agent: Mozilla/5.0.
// Unlike the /api/v2 fleet_order endpoint (HTTP 403 anti-bot from
// datacenter IPs), this one answers `retcode: 0` with the full journey in
// `data.sls_tracking_info.records[]` — no key, no login — verified live
// 2026-11-13 from a datacenter IP for both of Long's SPX codes
// (SPXVN06972458658B: 17 records through to Delivered; SPXVN06199468795B:
// in transit). Records carry buyer_description/description, actual_time
// (unix seconds), current_location (location_name/full_address).
async function fetchSpxOrderInfo(number: string): Promise<AdapterResult> {
  const outcome = await fetchCarrier(
    `https://spx.vn/shipment/order/open/order/get_order_info?spx_tn=${encodeURIComponent(number)}&language_code=vi`,
    {
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
        Referer: `https://spx.vn/track?${encodeURIComponent(number)}`,
      },
    },
  );
  if (outcome.kind !== "json") return { kind: "not_found" };
  const root = asRecord(outcome.json);
  const info = asRecord(asRecord(root?.data)?.sls_tracking_info);
  const rawRecords = Array.isArray(info?.records) ? info.records : [];
  const events: TrackingEvent[] = rawRecords
    .map((r): TrackingEvent | null => {
      const rec = asRecord(r);
      if (!rec) return null;
      const description =
        asString(rec.buyer_description) ?? asString(rec.description);
      const time = normalizeTime(rec.actual_time);
      if (!description || !time) return null;
      const loc = asRecord(rec.current_location);
      const location =
        asString(loc?.location_name) ?? asString(loc?.full_address) ?? null;
      return { time, description, location };
    })
    .filter((e): e is TrackingEvent => e !== null)
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
  if (events.length === 0) return { kind: "not_found" };
  return {
    kind: "ok",
    statusText: events[0]?.description ?? null,
    events,
    estimatedDelivery: null,
  };
}

// SPX chain: get_order_info first (free, works from datacenters), then
// LastScanned (only when a key is configured — keyless is refused from
// cloud IPs), then the direct SPX page as before.
async function fetchSpxChain(
  number: string,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const viaOrderInfo = await fetchSpxOrderInfo(number);
  if (viaOrderInfo.kind === "ok") return viaOrderInfo;
  const key = ctx?.lastScannedApiKey ?? null;
  if (key) {
    const viaLastScanned = await fetchLastScannedSpx(number, key);
    if (viaLastScanned.kind === "ok") return viaLastScanned;
    if (viaLastScanned.kind === "blocked" && viaLastScanned.specific) {
      return viaLastScanned;
    }
    // not_found / generic failure: fall through to the direct SPX page.
  }
  return fetchSpx(number);
}

// --- GHN: public gateway, but phone verification gates the journey. ----
//
// The gateway accepts `phone_verify` = sha256("<ORDER_CODE>|<phone>")
// (lowercase hex), or a 64-hex phone_verify token from an earlier
// verified call. The FULL phone number is required: the last 4 digits
// alone cannot reproduce the hash. The raw phone is never stored or
// logged — only the hash is sent to GHN, and the hash is returned to
// the client so a later refresh can reuse it without asking for the
// phone again. (Mechanism verified against the live gateway and the
// working naminc/spx-tracking-bot GHN service, 2026-11-13.)
const GHN_PHONE_VERIFY_PATTERN = /^[a-f0-9]{64}$/i;

function normalizeVietnamPhone(value: string): string {
  let normalized = value.replace(/[\s.\-()]/g, "");
  if (normalized.startsWith("+84")) normalized = `0${normalized.slice(3)}`;
  else if (normalized.startsWith("84") && normalized.length >= 10)
    normalized = `0${normalized.slice(2)}`;
  else if (normalized !== "" && !normalized.startsWith("0"))
    normalized = `0${normalized}`;
  if (normalized.length < 9 || !/^\d+$/.test(normalized)) return "";
  return normalized;
}

function resolveGhnPhoneVerify(
  number: string,
  credential: string | null | undefined,
): string | null {
  const trimmed = credential?.trim() ?? "";
  if (!trimmed) return null;
  if (GHN_PHONE_VERIFY_PATTERN.test(trimmed)) return trimmed.toLowerCase();
  const phone = normalizeVietnamPhone(trimmed);
  if (!phone) return null;
  return createHash("sha256")
    .update(`${number.trim().toUpperCase()}|${phone}`)
    .digest("hex");
}

async function fetchGhn(
  number: string,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const phoneVerify = resolveGhnPhoneVerify(number, ctx?.ghnCredential);
  const outcome = await fetchCarrier(
    "https://fe-online-gateway.ghn.vn/order-tracking/public-api/client/tracking-logs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        phoneVerify
          ? { order_code: number, phone_verify: phoneVerify }
          : { order_code: number },
      ),
    },
  );
  if (outcome.kind === "network") {
    return {
      kind: "blocked",
      reason:
        "Không kết nối được tới trang tra cứu của GHN lúc này. Thử lại sau ít phút.",
    };
  }
  if (outcome.kind !== "json") {
    return { kind: "blocked", reason: blockedReason("GHN") };
  }
  const root = asRecord(outcome.json);
  const codeMessage = asString(root?.code_message);
  if (codeMessage === "PHONE_VERIFY_REQUIRED") {
    return {
      kind: "phone_required",
      reason:
        "GHN yêu cầu xác thực số điện thoại của người gửi hoặc người nhận mới cho xem hành trình đơn này. Nhập số điện thoại đầy đủ (không dùng 4 số cuối) vào ô bên dưới để tra cứu.",
    };
  }
  if (codeMessage === "PHONE_VERIFY_FAIL") {
    return {
      kind: "phone_required",
      reason:
        "Số điện thoại vừa nhập chưa khớp với đơn này. Thử số điện thoại của người gửi, hoặc của người nhận.",
    };
  }
  const code = typeof root?.code === "number" ? root.code : null;
  if (code !== null && code !== 200) {
    return {
      kind: "blocked",
      reason: asString(root?.message) || blockedReason("GHN"),
    };
  }
  const data = asRecord(root?.data);
  const orderInfo = asRecord(data?.order_info);
  const rawLogs = Array.isArray(data?.tracking_logs)
    ? data.tracking_logs
    : [];
  const logs = rawLogs
    .map((entry): TrackingEvent | null => {
      const log = asRecord(entry);
      if (!log) return null;
      const time = normalizeTime(log.action_at);
      const description = asString(log.status_name) ?? asString(log.status);
      if (!time || !description) return null;
      const location = asRecord(log.location);
      return {
        time,
        description,
        location: asString(location?.address) ?? asString(log.location),
      };
    })
    .filter((e): e is TrackingEvent => e !== null)
    .sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
  const statusText =
    logs[0]?.description ?? asString(orderInfo?.status_name) ?? null;
  if (logs.length === 0 && !statusText) return { kind: "not_found" };
  return {
    kind: "ok",
    statusText,
    events: logs,
    estimatedDelivery: normalizeTime(orderInfo?.leadtime),
    phoneVerify,
  };
}

// --- Viettel Post: public API behind a Cloudflare bot wall. ------------
async function fetchViettelPost(number: string): Promise<AdapterResult> {
  const url = `https://api.viettelpost.vn/api/tracking/trackingbyordernumber?orderNumber=${encodeURIComponent(number)}`;
  const outcome = await fetchCarrier(url, {
    headers: {
      Accept: "application/json",
      Referer: "https://viettelpost.com.vn/",
    },
  });
  if (outcome.kind === "network") {
    return {
      kind: "blocked",
      reason:
        "Không kết nối được tới trang tra cứu của Viettel Post lúc này. Thử lại sau ít phút.",
    };
  }
  if (outcome.kind !== "json") {
    return { kind: "blocked", reason: blockedReason("Viettel Post") };
  }
  const events = extractEvents(outcome.json);
  const statusText = findStatusText(outcome.json);
  if (events.length === 0 && !statusText) return { kind: "not_found" };
  return { kind: "ok", statusText, events, estimatedDelivery: null };
}

// --- DHL: unified tracking endpoint that explicitly blocks bots. -------
async function fetchDhl(number: string): Promise<AdapterResult> {
  const url = `https://www.dhl.com/utapi?trackingNumber=${encodeURIComponent(number)}&language=en&requesterCountryCode=VN`;
  const outcome = await fetchCarrier(url, {
    headers: { Accept: "application/json" },
  });
  if (outcome.kind === "network") {
    return {
      kind: "blocked",
      reason:
        "Không kết nối được tới trang tra cứu của DHL lúc này. Thử lại sau ít phút.",
    };
  }
  if (outcome.kind !== "json") {
    return { kind: "blocked", reason: blockedReason("DHL") };
  }
  const events = extractEvents(outcome.json);
  const statusText = findStatusText(outcome.json);
  if (events.length === 0 && !statusText) return { kind: "not_found" };
  return { kind: "ok", statusText, events, estimatedDelivery: null };
}

// --- J&T: public site unreachable from this network (verified). --------
async function fetchJnt(number: string): Promise<AdapterResult> {
  const url = `https://jtexpress.vn/tracking?billcode=${encodeURIComponent(number)}`;
  const outcome = await fetchCarrier(url, undefined, 8000);
  if (outcome.kind === "network") {
    return {
      kind: "blocked",
      reason:
        "Không kết nối được tới trang tra cứu của J&T Express lúc này nên tạm thời chưa tra tự động được. Bạn tra mã này trực tiếp trên trang của J&T nhé.",
    };
  }
  if (outcome.kind === "json") {
    const events = extractEvents(outcome.json);
    const statusText = findStatusText(outcome.json);
    if (events.length === 0 && !statusText) return { kind: "not_found" };
    return { kind: "ok", statusText, events, estimatedDelivery: null };
  }
  return { kind: "blocked", reason: blockedReason("J&T Express") };
}

// --- FedEx / UPS: tracking sits behind Akamai bot checks. --------------
async function fetchFedex(number: string): Promise<AdapterResult> {
  const url = `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(number)}`;
  const outcome = await fetchCarrier(url);
  if (outcome.kind === "json") {
    const events = extractEvents(outcome.json);
    const statusText = findStatusText(outcome.json);
    if (events.length === 0 && !statusText) return { kind: "not_found" };
    return { kind: "ok", statusText, events, estimatedDelivery: null };
  }
  return { kind: "blocked", reason: blockedReason("FedEx") };
}

async function fetchUps(number: string): Promise<AdapterResult> {
  const outcome = await fetchCarrier("https://www.ups.com/track?loc=en_VN");
  if (outcome.kind === "json") {
    const events = extractEvents(outcome.json);
    const statusText = findStatusText(outcome.json);
    if (events.length === 0 && !statusText) return { kind: "not_found" };
    return { kind: "ok", statusText, events, estimatedDelivery: null };
  }
  return { kind: "blocked", reason: blockedReason("UPS") };
}

// --- Carriers with no unauthenticated public tracking endpoint. --------
function noPublicEndpoint(name: string, detail: string): AdapterResult {
  return {
    kind: "blocked",
    specific: true,
    reason: `${name} ${detail} Bạn tra mã này trực tiếp trên trang/ứng dụng của ${name} nhé — các hãng khác vẫn tra bình thường tại đây.`,
  };
}

// GHTK does have a public tracking page now (i.ghtk.vn, "Tracking đơn
// hàng chỉ 1 chạm", verified 2026-11-13): its API
// (GET iggw-service.giaohangtietkiem.vn/api/v2/package-tracking/get-package)
// answers from datacenter IPs with proper JSON, but every lookup requires
// a valid reCAPTCHA token (RType/RToken headers; invisible score token by
// default, checkbox when challenged) minted by Google's reCAPTCHA in a
// real browser on i.ghtk.vn — a dummy token is rejected with
// invalid_captcha, and a server cannot mint a valid one. So the server
// cannot fetch GHTK journeys directly; instead the carrier link below is
// a one-tap i.ghtk.vn/<code> URL that opens the tracking page with the
// code already filled in, and the visitor completes the captcha there.
async function fetchGhtkDirect(): Promise<AdapterResult> {
  return noPublicEndpoint(
    "GHTK",
    "có trang tra cứu công khai i.ghtk.vn, nhưng mỗi lần tra cần mã xác minh reCAPTCHA tạo trong trình duyệt nên máy chủ chưa lấy được dữ liệu tự động. Bấm link bên dưới là mở thẳng trang tra cứu với mã này đã điền sẵn, chỉ cần xác minh rồi xem hành trình.",
  );
}

async function fetchVnpost(): Promise<AdapterResult> {
  return noPublicEndpoint(
    "VNPost",
    "yêu cầu nhập mã xác nhận (captcha) trên trang tra cứu chính thức mới cho xem hành trình bưu gửi, nên web chưa lấy được dữ liệu tự động.",
  );
}

async function fetchNinjaVan(): Promise<AdapterResult> {
  return noPublicEndpoint(
    "Ninja Van",
    "chưa mở endpoint tra cứu công khai không cần đăng nhập mà web có thể lấy dữ liệu trực tiếp, nên tạm thời chưa tra tự động được.",
  );
}

async function fetchBest(): Promise<AdapterResult> {
  return noPublicEndpoint(
    "BEST Express",
    "chưa mở endpoint tra cứu công khai không cần đăng nhập mà web có thể lấy dữ liệu trực tiếp, nên tạm thời chưa tra tự động được.",
  );
}

// Detection patterns follow each carrier's real waybill format:
// - SPX VN: "SPXVN" + 11 digits + 1 trailing check letter (the standard
//   printed format, e.g. SPXVN02883837211B); some codes are digits-only or
//   longer, so anything alphanumeric after the SPXVN prefix counts.
// - GHTK: dotted hub format (S160689.MN1.…) or "S" + 9–12 digits with an
//   optional trailing letter.
// - VNPost / EMS: UPU S10 — 2 letters + 9 digits + 2 letters (…VN).
// - UPS: "1Z" + 16 alphanumeric. DHL: 10 digits (or JJD… eCommerce codes).
//   FedEx: 12 / 15 / 20 / 22 digits.
// - J&T VN: 12 digits starting with 8 (international JT… codes too).
// - BEST VN: "BEST…" or a numeric waybill starting with 88.
// - GHN: "G" + 7–14 alphanumeric order code.
// - Viettel Post: 10–13 digit numeric waybill.
// - Ninja Van: "NV…" or Shopee-style "SHP" + digits.
const CARRIERS: CarrierDef[] = [
  {
    id: "spx",
    name: "SPX — Shopee Express",
    url: "https://spx.vn/track",
    detect: (n) => /^SPXVN[0-9A-Z]+$/i.test(n),
    fetchTracking: fetchSpxChain,
  },
  {
    id: "ghtk",
    name: "GHTK — Giao Hàng Tiết Kiệm",
    url: (n) => `https://i.ghtk.vn/${encodeURIComponent(n)}`,
    detect: (n) =>
      /^[A-Z0-9]+(\.[A-Z0-9]+){2,}$/i.test(n) || /^S\d{9,12}[A-Z]?$/.test(n),
    fetchTracking: fetchGhtkDirect,
  },
  {
    id: "vnpost",
    name: "VNPost — Bưu điện Việt Nam",
    url: "https://vnpost.vn/",
    detect: (n) => /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n),
    fetchTracking: fetchVnpost,
  },
  {
    id: "ups",
    name: "UPS",
    url: "https://www.ups.com/track?loc=en_VN",
    detect: (n) => /^1Z[0-9A-Z]{16}$/i.test(n),
    fetchTracking: fetchUps,
  },
  {
    id: "jnt",
    name: "J&T Express Việt Nam",
    url: "https://jtexpress.vn/",
    detect: (n) => /^8\d{11}$/.test(n) || /^JT[0-9A-Z]{8,}$/i.test(n),
    fetchTracking: fetchJnt,
  },
  {
    id: "ninjavan",
    name: "Ninja Van Việt Nam",
    url: "https://www.ninjavan.co/vi-vn/tracking",
    detect: (n) => /^NV[A-Z0-9]{8,}$/i.test(n) || /^SHP\d{8,}$/i.test(n),
    fetchTracking: fetchNinjaVan,
  },
  {
    id: "best",
    name: "BEST Express Việt Nam",
    url: "https://www.best-inc.vn/",
    detect: (n) => /^BEST[A-Z0-9]{4,}$/i.test(n) || /^88\d{10,12}$/.test(n),
    fetchTracking: fetchBest,
  },
  {
    id: "ghn",
    name: "GHN — Giao Hàng Nhanh",
    url: "https://donhang.ghn.vn/",
    detect: (n) => /^G[A-Z0-9]{7,14}$/.test(n),
    fetchTracking: fetchGhn,
  },
  {
    id: "viettelpost",
    name: "Viettel Post",
    url: "https://viettelpost.com.vn/tra-cuu-hanh-trinh-don/",
    detect: (n) => /^\d{10,13}$/.test(n),
    fetchTracking: fetchViettelPost,
  },
  {
    id: "dhl",
    name: "DHL Express",
    url: null,
    detect: (n) => /^\d{10}$/.test(n) || /^JJD[0-9A-Z]{7,}$/i.test(n),
    fetchTracking: fetchDhl,
  },
  {
    id: "fedex",
    name: "FedEx",
    url: null,
    detect: (n) => /^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(n),
    fetchTracking: fetchFedex,
  },
];

const GHTK_CARRIER_NAME = "GHTK — Giao Hàng Tiết Kiệm";
/** One-tap public tracking link: i.ghtk.vn/<code> opens the tracking page
 * with the code already filled in (verified 2026-11-13). */
function ghtkTrackUrl(number: string): string {
  return `https://i.ghtk.vn/${encodeURIComponent(number)}`;
}

function carrierById(id: string): CarrierDef | null {
  return CARRIERS.find((c) => c.id === id) ?? null;
}

function isGhtkFormat(number: string): boolean {
  return carrierById("ghtk")?.detect(number) ?? false;
}

// Strict matches are carriers whose own waybill pattern claims the code;
// fallback guesses are format-class heuristics for codes no strict pattern
// claimed (e.g. any alphanumeric code is guessed as GHN). The two groups
// must stay separate: a fallback guess must never override a strict match.
// GHN's gateway answers PHONE_VERIFY_REQUIRED for any code sent without a
// phone hash — it never checks whether the code exists first — so letting
// the GHN guess answer first turned e.g. a VNPost EMS code (S10,
// EE123456789VN) into a "GHN wants your phone number" prompt.
function candidateCarriers(
  number: string,
  preferredCarrierName: string | null,
): { strict: CarrierDef[]; fallback: CarrierDef[] } {
  const strict: CarrierDef[] = [];
  const fallback: CarrierDef[] = [];
  const addStrict = (c: CarrierDef | null): void => {
    if (c && !strict.includes(c) && !fallback.includes(c)) strict.push(c);
  };
  const addFallback = (c: CarrierDef | null): void => {
    if (c && !strict.includes(c) && !fallback.includes(c)) fallback.push(c);
  };
  if (preferredCarrierName) {
    addStrict(CARRIERS.find((c) => c.name === preferredCarrierName) ?? null);
  }
  for (const c of CARRIERS) {
    if (c.detect(number)) addStrict(c);
  }
  // Format-class fallbacks for codes no strict pattern claimed.
  if (/^\d{9,13}$/.test(number)) {
    addFallback(carrierById("viettelpost"));
    if (number.length === 10) addFallback(carrierById("dhl"));
    if (number.length === 12 || number.length === 15) addFallback(carrierById("fedex"));
    if (/^8\d{11}$/.test(number)) addFallback(carrierById("jnt"));
  }
  if (
    /^[A-Z0-9]{6,18}$/.test(number) &&
    /[A-Z]/.test(number) &&
    /\d/.test(number)
  ) {
    addFallback(carrierById("ghn"));
    addFallback(carrierById("ninjavan"));
  }
  return { strict, fallback };
}

// ---------------------------------------------------------------------------
// Lookup outcomes shared by every data source
// ---------------------------------------------------------------------------

export type LookupOutcome =
  | { state: "ok"; result: TrackingResult }
  | {
      state: "not_found";
      message: string;
      carrierName: string | null;
      carrierUrl: string | null;
    }
  | {
      state: "carrier_unavailable";
      message: string;
      carrierName: string | null;
      carrierUrl: string | null;
    }
  | {
      state: "phone_required";
      message: string;
      carrierName: string | null;
      carrierUrl: string | null;
    }
  | {
      state: "not_configured";
      message: string;
      carrierName: string | null;
      carrierUrl: string | null;
    }
  | { state: "error"; message: string };

// ---------------------------------------------------------------------------
// Direct fallback chain: try the detected carriers' public pages in order
// until one returns real data. Blocked outcomes never stop the chain —
// another carrier may still own the code — but they are remembered for
// the honest message.
// ---------------------------------------------------------------------------

async function lookupDirect(
  number: string,
  preferredCarrierName: string | null,
  ctx?: AdapterContext,
): Promise<LookupOutcome> {
  const { strict, fallback } = candidateCarriers(number, preferredCarrierName);
  // A code a strict pattern claimed belongs to that carrier: never let a
  // fallback guess (GHN's phone prompt) answer for it. Guesses are only
  // tried when no strict pattern matched at all.
  const candidates = strict.length > 0 ? strict : fallback;
  if (candidates.length === 0) {
    return {
      state: "not_found",
      message:
        "Không nhận diện được hãng vận chuyển từ mã này. Kiểm tra lại mã vận đơn — mã phải đúng định dạng của hãng (ví dụ mã SPX có dạng SPXVN + dãy số, thường kết thúc bằng một chữ cái như B; mã bưu điện có dạng 2 chữ cái + 9 số + VN).",
      carrierName: null,
      carrierUrl: null,
    };
  }

  const blocked: { carrier: CarrierDef; reason: string; specific: boolean }[] = [];
  let phoneRequired: { carrier: CarrierDef; reason: string } | null = null;
  let firstNotFound: CarrierDef | null = null;

  for (const carrier of candidates) {
    const outcome = await carrier.fetchTracking(number, ctx);
    if (outcome.kind === "ok") {
      const latest = outcome.events[0];
      const status = classifyStatus(outcome.statusText ?? latest?.description ?? null);
      return {
        state: "ok",
        result: {
          number,
          carrierKey: null,
          carrierName: carrier.name,
          status,
          statusLabel: statusLabel(status),
          latestEvent: latest?.description ?? outcome.statusText,
          latestEventTime: latest?.time ?? null,
          estimatedDelivery: outcome.estimatedDelivery,
          phoneVerify: outcome.phoneVerify ?? null,
          originCountry: null,
          destinationCountry: null,
          events: outcome.events,
        },
      };
    }
    if (outcome.kind === "phone_required") {
      if (!phoneRequired) {
        phoneRequired = { carrier, reason: outcome.reason };
      }
    } else if (outcome.kind === "blocked") {
      blocked.push({
        carrier,
        reason: outcome.reason,
        specific: outcome.specific === true,
      });
    } else if (!firstNotFound) {
      firstNotFound = carrier;
    }
  }

  if (phoneRequired) {
    return {
      state: "phone_required",
      message: phoneRequired.reason,
      carrierName: phoneRequired.carrier.name,
      carrierUrl: resolveCarrierUrl(phoneRequired.carrier, number),
    };
  }

  const firstBlocked = blocked[0];
  if (firstBlocked) {
    return {
      state: "carrier_unavailable",
      message:
        blocked.length === 1 || firstBlocked.specific
          ? firstBlocked.reason
          : `Các hãng ${blocked
              .map((b) => b.carrier.name)
              .join(
                ", ",
              )} đang chặn lấy dữ liệu tự động (kiểm tra bot/captcha) hoặc vừa đổi cấu trúc trang nên tạm thời chưa tra được mã này. Thử tra trực tiếp trên trang của hãng.`,
      carrierName: firstBlocked.carrier.name,
      carrierUrl: resolveCarrierUrl(firstBlocked.carrier, number),
    };
  }

  return {
    state: "not_found",
    message:
      "Chưa tìm thấy thông tin cho mã vận đơn này. Kiểm tra lại mã hoặc thử lại sau ít giờ (đơn mới tạo thường mất một thời gian mới có dữ liệu).",
    carrierName: firstNotFound?.name ?? null,
    carrierUrl: null,
  };
}

// ---------------------------------------------------------------------------
// 17TRACK Tracking API v2.4 (docs: https://api.17track.net/en/doc)
//
// POST https://api.17track.net/track/v2.4/gettrackinfo with header
// `17token: <key>` and body [{ number, carrier?, lang }]. A number must be
// registered once before its details can be read: gettrackinfo rejects
// unregistered numbers with error -18019902, so the flow is
// gettrackinfo → (if needed) /register → gettrackinfo again. The carrier
// parameter is omitted so 17TRACK auto-detects it; the accepted item
// returns the detected carrier key plus track_info with the normalized
// 9-value main status, per-provider event lists, latest event, estimated
// delivery window and origin/destination countries.
// ---------------------------------------------------------------------------

const TRACK17_BASE = "https://api.17track.net/track/v2.4";

type Track17Outcome =
  | { kind: "ok"; result: TrackingResult }
  | { kind: "not_found" }
  | { kind: "pending" }
  | { kind: "undetectable" }
  | { kind: "need_register"; carrierKey: number | null }
  | { kind: "api_error"; reason: string };

async function track17Post(
  key: string,
  path: string,
  items: Record<string, unknown>[],
): Promise<{ httpStatus: number; json: unknown } | null> {
  try {
    const res = await fetch(`${TRACK17_BASE}${path}`, {
      method: "POST",
      headers: { "17token": key, "Content-Type": "application/json" },
      body: JSON.stringify(items),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    try {
      return { httpStatus: res.status, json: JSON.parse(text) as unknown };
    } catch {
      return { httpStatus: res.status, json: null };
    }
  } catch {
    return null;
  }
}

function track17Item(
  number: string,
  carrierKey: number | null,
): Record<string, unknown> {
  const item: Record<string, unknown> = { number, lang: "vi" };
  if (carrierKey != null) item.carrier = carrierKey;
  return item;
}

type Track17Envelope = {
  accepted: Record<string, unknown>[];
  rejected: { errorCode: number | null }[];
};

function track17Envelope(json: unknown): Track17Envelope {
  const root = asRecord(json);
  const data = asRecord(root?.data);
  const acceptedRaw = Array.isArray(data?.accepted) ? data.accepted : [];
  const rejectedRaw = Array.isArray(data?.rejected) ? data.rejected : [];
  return {
    accepted: acceptedRaw.flatMap((item) => {
      const rec = asRecord(item);
      return rec ? [rec] : [];
    }),
    rejected: rejectedRaw.flatMap((item) => {
      const rec = asRecord(item);
      if (!rec) return [];
      const error = asRecord(rec.error);
      return [{ errorCode: asNumber(error?.code) }];
    }),
  };
}

function track17HttpError(httpStatus: number): Track17Outcome | null {
  if (httpStatus === 401) {
    return {
      kind: "api_error",
      reason:
        "API key 17TRACK trên máy chủ không hợp lệ hoặc tài khoản đã bị khóa (17TRACK trả lỗi 401). Người quản trị cần kiểm tra lại biến TRACK17_API_KEY.",
    };
  }
  if (httpStatus === 429) {
    return {
      kind: "api_error",
      reason:
        "17TRACK đang giới hạn tốc độ gọi API (tối đa 3 yêu cầu/giây) hoặc tài khoản đã hết hạn mức tra cứu. Thử lại sau ít phút; nếu vẫn lỗi, người quản trị cần kiểm tra hạn mức của tài khoản 17TRACK.",
    };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      kind: "api_error",
      reason: `17TRACK trả lỗi máy chủ (HTTP ${httpStatus}) nên tạm thời chưa tra qua API được. Thử lại sau ít phút.`,
    };
  }
  return null;
}

function parseTrack17Accepted(
  number: string,
  item: Record<string, unknown>,
): Track17Outcome {
  const carrierKey = asNumber(item.carrier);
  const info = asRecord(item.track_info);
  if (!info) return { kind: "pending" };

  const latestStatus = asRecord(info.latest_status);
  const rawStatus = asString(latestStatus?.status);

  // Merge every provider's event list (a shipment can hand over between
  // carriers; each provider carries its own events and display name).
  const tracking = asRecord(info.tracking);
  const providersRaw =
    tracking && Array.isArray(tracking.providers) ? tracking.providers : [];
  let carrierName: string | null = null;
  const events: TrackingEvent[] = [];
  for (const providerItem of providersRaw) {
    const providerRec = asRecord(providerItem);
    if (!providerRec) continue;
    const provider = asRecord(providerRec.provider);
    if (!carrierName) carrierName = asString(provider?.name);
    const providerEvents = Array.isArray(providerRec.events)
      ? providerRec.events
      : [];
    for (const eventItem of providerEvents) {
      const eventRec = asRecord(eventItem);
      if (!eventRec) continue;
      const translation = asRecord(eventRec.description_translation);
      const description =
        asString(translation?.description) ?? asString(eventRec.description);
      if (!description) continue;
      events.push({
        time:
          normalizeTime(eventRec.time_utc) ?? normalizeTime(eventRec.time_iso),
        description,
        location: asString(eventRec.location),
      });
    }
  }
  const sorted = sortEvents(events);

  if (rawStatus === "NotFound") return { kind: "not_found" };
  if (sorted.length === 0 && rawStatus == null) return { kind: "pending" };

  const latestEventRec = asRecord(info.latest_event);
  const latestTranslation = asRecord(latestEventRec?.description_translation);
  const latestDescription =
    asString(latestTranslation?.description) ??
    asString(latestEventRec?.description) ??
    sorted[0]?.description ??
    null;
  const latestTime =
    (latestEventRec
      ? (normalizeTime(latestEventRec.time_utc) ??
        normalizeTime(latestEventRec.time_iso))
      : null) ??
    sorted[0]?.time ??
    null;

  const status =
    rawStatus != null && STATUS_VI[rawStatus] != null
      ? rawStatus
      : classifyStatus(latestDescription);

  const metrics = asRecord(info.time_metrics);
  const eta = asRecord(metrics?.estimated_delivery_date);
  const etaFrom = asString(eta?.from)?.slice(0, 10) ?? null;
  const etaTo = asString(eta?.to)?.slice(0, 10) ?? null;
  const estimatedDelivery =
    etaFrom && etaTo && etaFrom !== etaTo
      ? `${etaFrom} – ${etaTo}`
      : etaFrom;

  const shipping = asRecord(info.shipping_info);
  const shipperAddress = asRecord(shipping?.shipper_address);
  const recipientAddress = asRecord(shipping?.recipient_address);

  return {
    kind: "ok",
    result: {
      number,
      carrierKey,
      carrierName,
      status,
      statusLabel: statusLabel(status),
      latestEvent: latestDescription,
      latestEventTime: latestTime,
      estimatedDelivery,
      originCountry: countryName(
        asString(shipperAddress?.country) ?? asString(item.origin_country),
      ),
      destinationCountry: countryName(
        asString(recipientAddress?.country) ??
          asString(item.destination_country),
      ),
      events: sorted,
    },
  };
}

async function track17GetInfo(
  number: string,
  key: string,
  carrierKey: number | null,
): Promise<Track17Outcome> {
  const res = await track17Post(key, "/gettrackinfo", [
    track17Item(number, carrierKey),
  ]);
  if (!res) {
    return {
      kind: "api_error",
      reason:
        "Không kết nối được tới máy chủ API của 17TRACK lúc này. Thử lại sau ít phút.",
    };
  }
  const httpError = track17HttpError(res.httpStatus);
  if (httpError) return httpError;
  const root = asRecord(res.json);
  if (!root || (typeof root.code === "number" && root.code !== 0)) {
    return {
      kind: "api_error",
      reason:
        "17TRACK trả phản hồi lỗi nên tạm thời chưa tra qua API được. Thử lại sau ít phút.",
    };
  }
  const envelope = track17Envelope(res.json);
  const accepted = envelope.accepted[0];
  if (accepted) return parseTrack17Accepted(number, accepted);
  const rejected = envelope.rejected[0];
  if (rejected) {
    if (rejected.errorCode === -18019902) {
      return { kind: "need_register", carrierKey };
    }
    if (rejected.errorCode === -18019903) return { kind: "undetectable" };
    // -18019909 (no tracking info yet) and anything else: treat as
    // "registered but no data yet" and let the fallback chain try.
    return { kind: "pending" };
  }
  return { kind: "pending" };
}

async function fetch17Track(
  number: string,
  key: string,
  savedCarrierKey: number | null,
): Promise<Track17Outcome> {
  const first = await track17GetInfo(number, key, savedCarrierKey);
  if (first.kind !== "need_register") return first;

  const reg = await track17Post(key, "/register", [
    track17Item(number, savedCarrierKey),
  ]);
  if (!reg) {
    return {
      kind: "api_error",
      reason:
        "Không kết nối được tới máy chủ API của 17TRACK để đăng ký mã này. Thử lại sau ít phút.",
    };
  }
  const httpError = track17HttpError(reg.httpStatus);
  if (httpError) return httpError;
  const envelope = track17Envelope(reg.json);
  const accepted = envelope.accepted[0];
  const rejected = envelope.rejected[0];
  if (!accepted) {
    if (rejected?.errorCode === -18019903) return { kind: "undetectable" };
    if (rejected?.errorCode !== -18019901) {
      // -18019901 means "already registered" — that is fine, fall
      // through and read the details. Anything else is unexpected.
      return { kind: "pending" };
    }
  }
  const registeredCarrierKey = asNumber(accepted?.carrier) ?? savedCarrierKey;
  // 17TRACK usually returns the first tracking result within seconds of
  // registration; give it a brief moment before reading once more.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = await track17GetInfo(number, key, registeredCarrierKey);
  if (second.kind === "need_register") return { kind: "pending" };
  return second;
}

// ---------------------------------------------------------------------------
// GHTK official API (docs:
// https://api.ghtk.vn/docs/submit-order/tracking-status/ and the status
// code table at https://api.ghtk.vn/docs/submit-order/webhook/)
//
// GET https://services.giaohangtietkiem.vn/services/shipment/v2/{code}
// with headers `Token: <shop API token>` and
// `X-Client-Source: <shop code>`. The response carries the CURRENT status
// only (status code + status_text, created/modified/pick_date/
// deliver_date) — the API exposes no journey/log list, so the timeline
// here is built solely from those real timestamps; nothing is invented.
// The token belongs to ONE shop account: the API only finds orders of
// that shop (by GHTK label id or the shop's own partner order id).
// Recipient name/phone/address fields in the response are personal data
// and are deliberately never stored or displayed.
// ---------------------------------------------------------------------------

const GHTK_STATUS_MAP: Record<string, { status: string; text: string }> = {
  "-1": { status: "Exception", text: "Hủy đơn hàng" },
  "1": { status: "InfoReceived", text: "Chưa tiếp nhận" },
  "2": { status: "InfoReceived", text: "Đã tiếp nhận" },
  "3": { status: "InTransit", text: "Đã lấy hàng/Đã nhập kho" },
  "4": { status: "OutForDelivery", text: "Đang giao hàng" },
  "5": { status: "Delivered", text: "Đã giao hàng" },
  "6": { status: "Delivered", text: "Đã giao hàng (đã đối soát)" },
  "7": { status: "DeliveryFailure", text: "Không lấy được hàng" },
  "8": { status: "InTransit", text: "Hoãn lấy hàng" },
  "9": { status: "DeliveryFailure", text: "Không giao được hàng" },
  "10": { status: "InTransit", text: "Delay giao hàng" },
  "11": { status: "Exception", text: "Đã đối soát công nợ trả hàng" },
  "12": { status: "InfoReceived", text: "Đang lấy hàng" },
  "13": { status: "Exception", text: "Đơn hàng bồi hoàn" },
  "20": { status: "Exception", text: "Đang trả hàng" },
  "21": { status: "Exception", text: "Đã trả hàng" },
  "123": { status: "InTransit", text: "Shipper báo đã lấy hàng" },
  "127": { status: "DeliveryFailure", text: "Shipper báo không lấy được hàng" },
  "128": { status: "InTransit", text: "Shipper báo delay lấy hàng" },
  "45": { status: "Delivered", text: "Shipper báo đã giao hàng" },
  "49": { status: "DeliveryFailure", text: "Shipper báo không giao được hàng" },
  "410": { status: "InTransit", text: "Shipper báo delay giao hàng" },
};

async function lookupGhtkApi(
  number: string,
  config: ApiConfig,
): Promise<LookupOutcome> {
  const token = config.ghtkApiToken;
  if (!token) {
    return {
      state: "not_configured",
      message:
        "Mã này thuộc GHTK — Giao Hàng Tiết Kiệm. GHTK không có trong danh mục của 17TRACK, nên muốn tra tự động phải dùng API chính thức của GHTK bằng token của một tài khoản shop GHTK. Hiện máy chủ chưa cấu hình token này (biến GHTK_API_TOKEN, kèm mã shop GHTK_CLIENT_SOURCE) nên chưa tra được mã GHTK tại đây. Bấm link bên dưới là mở thẳng trang tra cứu i.ghtk.vn với mã này đã điền sẵn, chỉ cần xác minh rồi xem hành trình.",
      carrierName: GHTK_CARRIER_NAME,
      carrierUrl: ghtkTrackUrl(number),
    };
  }

  const headers: Record<string, string> = { Token: token };
  if (config.ghtkClientSource) {
    headers["X-Client-Source"] = config.ghtkClientSource;
  }
  let res: Response;
  try {
    res = await fetch(
      `https://services.giaohangtietkiem.vn/services/shipment/v2/${encodeURIComponent(number)}`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
  } catch {
    return {
      state: "carrier_unavailable",
      message:
        "Không kết nối được tới máy chủ API của GHTK lúc này. Thử lại sau ít phút.",
      carrierName: GHTK_CARRIER_NAME,
      carrierUrl: ghtkTrackUrl(number),
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      state: "carrier_unavailable",
      message:
        "GHTK từ chối token API trên máy chủ (token sai, hết hạn hoặc thiếu quyền 'Trạng thái đơn hàng'). Người quản trị cần kiểm tra lại biến GHTK_API_TOKEN và GHTK_CLIENT_SOURCE trong cấu hình máy chủ.",
      carrierName: GHTK_CARRIER_NAME,
      carrierUrl: ghtkTrackUrl(number),
    };
  }

  let json: unknown = null;
  try {
    json = JSON.parse(await res.text()) as unknown;
  } catch {
    json = null;
  }
  const root = asRecord(json);
  const order = asRecord(root?.order);
  if (!root || root.success !== true || !order) {
    return {
      state: "not_found",
      message:
        "API GHTK không tìm thấy đơn này. Lưu ý: API GHTK chỉ tra được các đơn thuộc đúng tài khoản shop đã cấp token (theo mã vận đơn GHTK hoặc mã đơn của shop đó) — đơn của shop khác sẽ không tra được bằng token này. Kiểm tra lại mã, hoặc tra trên trang/ứng dụng của GHTK.",
      carrierName: GHTK_CARRIER_NAME,
      carrierUrl: ghtkTrackUrl(number),
    };
  }

  const statusCode =
    typeof order.status === "string" || typeof order.status === "number"
      ? String(order.status)
      : "";
  const mapped = GHTK_STATUS_MAP[statusCode];
  const statusText =
    asString(order.status_text) ?? mapped?.text ?? "Đang xử lý";
  const status = mapped?.status ?? classifyStatus(statusText);

  const created = normalizeTime(order.created);
  const modified = normalizeTime(order.modified);
  const pickDate = asString(order.pick_date);
  const deliverDate = asString(order.deliver_date);

  const events: TrackingEvent[] = [];
  if (created) {
    events.push({
      time: created,
      description: "Đơn hàng được tạo trên hệ thống GHTK",
      location: null,
    });
  }
  if (pickDate && /^\d{4}-\d{2}-\d{2}/.test(pickDate)) {
    events.push({
      time: normalizeTime(pickDate.slice(0, 10)),
      description: "Ngày lấy hàng",
      location: null,
    });
  }
  if (modified) {
    events.push({ time: modified, description: statusText, location: null });
  }
  const sorted = sortEvents(events);
  const latest = sorted[0];

  return {
    state: "ok",
    result: {
      number,
      carrierKey: null,
      carrierName: GHTK_CARRIER_NAME,
      status,
      statusLabel: statusText,
      latestEvent: latest?.description ?? statusText,
      latestEventTime: latest?.time ?? modified,
      estimatedDelivery:
        deliverDate && /^\d{4}-\d{2}-\d{2}/.test(deliverDate)
          ? deliverDate.slice(0, 10)
          : null,
      originCountry: null,
      destinationCountry: null,
      events: sorted,
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration: GHTK format → GHTK API. Everything else → 17TRACK API
// first; when the API has no result (or errors), fall back to the direct
// per-carrier adapters. Without a 17TRACK key, codes whose format no
// direct adapter recognizes get the explicit not_configured state.
// ---------------------------------------------------------------------------

const TRACK17_NOT_CONFIGURED_MESSAGE =
  "Chưa cấu hình API key 17TRACK trên máy chủ (biến TRACK17_API_KEY) nên web chưa tra được mã này qua API, và định dạng mã cũng không khớp hãng nào tra trực tiếp được. Người quản trị tạo tài khoản miễn phí tại 17track.net, lấy API key trong mục Settings của trang API rồi cài vào cấu hình máy chủ là tra được hầu hết các hãng.";

export async function lookupTrackingNumber(
  number: string,
  preferred: { carrierName: string | null; carrierKey: number | null },
  config: ApiConfig,
  ghnCredential?: string | null,
): Promise<LookupOutcome> {
  if (isGhtkFormat(number) || preferred.carrierName === GHTK_CARRIER_NAME) {
    return lookupGhtkApi(number, config);
  }

  let apiPending = false;
  let apiErrorReason: string | null = null;
  if (config.track17ApiKey) {
    const apiResult = await fetch17Track(
      number,
      config.track17ApiKey,
      preferred.carrierKey,
    );
    if (apiResult.kind === "ok") return { state: "ok", result: apiResult.result };
    if (apiResult.kind === "api_error") {
      apiErrorReason = apiResult.reason;
    } else if (apiResult.kind === "pending") {
      apiPending = true;
    }
    // not_found / undetectable: fall through to the direct adapters —
    // a carrier page may still know this code.
  }

  const direct = await lookupDirect(number, preferred.carrierName, {
    lastScannedApiKey: config.lastScannedApiKey,
    ghnCredential: ghnCredential ?? null,
  });
  if (direct.state === "ok") return direct;
  if (apiPending && direct.state === "not_found") {
    return {
      state: "not_found",
      message:
        "17TRACK đã nhận mã này nhưng dữ liệu hành trình chưa sẵn sàng — mã mới đăng ký thường mất vài phút mới có kết quả. Bấm Cập nhật lại sau ít phút nhé.",
      carrierName: direct.carrierName,
      carrierUrl: null,
    };
  }
  if (direct.state === "not_found" && apiErrorReason) {
    return {
      state: "carrier_unavailable",
      message: apiErrorReason,
      carrierName: direct.carrierName,
      carrierUrl: null,
    };
  }
  if (
    direct.state === "not_found" &&
    !config.track17ApiKey &&
    (() => {
      const c = candidateCarriers(number, preferred.carrierName);
      return c.strict.length === 0 && c.fallback.length === 0;
    })()
  ) {
    return {
      state: "not_configured",
      message: TRACK17_NOT_CONFIGURED_MESSAGE,
      carrierName: null,
      carrierUrl: null,
    };
  }
  return direct;
}


// ---------------------------------------------------------------------------
// Response shaping (same contract the client renders)
// ---------------------------------------------------------------------------

export type TrackResponseBody = {
  state:
    | "ok"
    | "not_found"
    | "carrier_unavailable"
    | "not_configured"
    | "phone_required"
    | "error";
  message: string | null;
  carrierName: string | null;
  carrierUrl: string | null;
  track17Configured: boolean;
  ghtkConfigured: boolean;
  lastScannedConfigured: boolean;
  result: TrackingResult | null;
};

export function toTrackResponse(
  outcome: LookupOutcome,
  config: ApiConfig,
): TrackResponseBody {
  const flags = {
    track17Configured: config.track17ApiKey != null,
    ghtkConfigured: config.ghtkApiToken != null,
    lastScannedConfigured: config.lastScannedApiKey != null,
  };
  if (outcome.state === "ok") {
    return {
      state: "ok",
      message: null,
      carrierName: outcome.result.carrierName,
      carrierUrl: null,
      ...flags,
      result: outcome.result,
    };
  }
  if (outcome.state === "error") {
    return {
      state: "error",
      message: outcome.message,
      carrierName: null,
      carrierUrl: null,
      ...flags,
      result: null,
    };
  }
  return {
    state: outcome.state,
    message: outcome.message,
    carrierName: outcome.carrierName,
    carrierUrl: outcome.carrierUrl,
    ...flags,
    result: null,
  };
}
