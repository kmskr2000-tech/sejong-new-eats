// 세종 신규 음식점 데이터 API (Vercel 함수)
// 공공데이터포털 행정안전부_식품_일반음식점·휴게음식점 조회서비스를 조회해
// 대시보드(index.html)가 읽는 restaurants.json 형식으로 돌려준다.
// CDN 캐시(6시간) + stale-while-revalidate 로 자동 갱신된다.
const proj4 = require("proj4");
// 공공데이터에 좌표가 없는 곳의 근사 좌표 캐시(id -> [lat, lng]). 없는 곳만 Nominatim 으로 조회
let GEO = {};
try { GEO = require("./geo.json"); } catch {}

const SERVICES = [
  ["일반음식점", "https://apis.data.go.kr/1741000/general_restaurants/info"],
  ["휴게음식점", "https://apis.data.go.kr/1741000/rest_cafes/info"],
];
const SEJONG_CODE = "5690000";
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 365);
const EPSG5174 = "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 " +
  "+ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43";

const EXCLUDE_TYPES = new Set(["편의점", "철도역구내", "유원지", "출장조리", "이동조리"]);
const EXCLUDE_NAME = /(GS25|지에스25|CU|씨유|세븐일레븐|이마트24|미니스톱|홈플러스|이마트\b|롯데마트)/i;

const GENRE_RULES = [ // [장르, 위생업태명 키워드, 상호 키워드]
  ["카페·디저트", ["까페", "커피", "다방", "제과", "아이스크림", "떡카페", "전통찻집", "키즈카페"],
    ["카페", "커피", "베이커리", "제과", "디저트", "케이크", "브레드", "빵", "젤라또", "티하우스", "빙수", "샌드", "와플", "도넛", "베이글", "크리스피"]],
  ["술집", ["호프", "정종", "대포집", "소주방", "감성주점", "라이브카페", "룸살롱"],
    ["포차", "주점", "이자카야", "호프", "와인", "펍", "비어", "맥주", "술집", "바$", " bar", "하이볼", "양조", "브로이", "브루", "탭룸"]],
  ["치킨", ["통닭", "치킨"], ["치킨", "통닭"]],
  ["고기구이", ["식육", "숯불구이"],
    ["갈비", "삼겹", "고기", "한우", "정육", "곱창", "막창", "숯불", "목살", "돼지", "양꼬치", "족발", "보쌈"]],
  ["일식", ["일식", "횟집", "회집"],
    ["스시", "초밥", "오마카세", "돈카츠", "돈까스", "돈가스", "라멘", "우동", "소바", "이자카야", "덮밥", "텐동", "카레", "횟집", "회센터", "사시미"]],
  ["중식", ["중국식"], ["반점", "짬뽕", "짜장", "마라", "훠궈", "중화", "딤섬", "탕후루"]],
  ["양식", ["경양식", "패밀리레스트랑", "패밀리레스토랑"],
    ["파스타", "피자", "스테이크", "브런치", "버거", "비스트로", "트라토리아", "키친", "다이닝"]],
  ["아시아", ["외국음식"], ["쌀국수", "베트남", "타이", "태국", "인도", "커리", "포 ", "분짜", "멕시"]],
  ["분식·간편식", ["분식", "김밥", "패스트푸드", "일반조리판매", "도시락", "푸드트럭"],
    ["김밥", "떡볶이", "분식", "토스트", "샌드위치", "샐러", "도시락", "핫도그", "만두", "버거"]],
  ["국밥·면", ["냉면", "탕류"],
    ["국밥", "해장", "설렁탕", "곰탕", "순대", "국수", "칼국수", "냉면", "막국수", "감자탕", "추어탕", "삼계탕", "백숙"]],
  ["한식", ["한식", "뷔페"], ["한식", "백반", "식당", "밥상", "찌개", "정식", "쌈밥", "한정식", "보리밥", "닭갈비", "찜닭", "아구", "아귀"]],
];

function genreOf(btype = "", name = "") {
  if (btype.includes("호프") && /치킨|통닭/.test(name)) return "치킨";
  for (const [g, types] of GENRE_RULES) {
    if (types.some(t => btype.includes(t))) { if (g === "한식") break; return g; }
  }
  for (const [g, , words] of GENRE_RULES) {
    if (words.some(w => new RegExp(w, "i").test(name))) return g;
  }
  if (btype.includes("한식") || btype.includes("뷔페")) return "한식";
  return "기타";
}

function dongOf(road = "", lot = "") {
  const m = road.match(/\(([^)]*?(동|읍|면|리))[,)]/);
  if (m) return m[1].split(",")[0].trim();
  for (const p of lot.split(/\s+/).slice(1, 3)) if (/(동|읍|면)$/.test(p)) return p;
  return "기타";
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);

async function call(url, key, params) {
  const qs = new URLSearchParams({ serviceKey: key, returnType: "json", ...params });
  let err;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(30000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = JSON.parse(text);
      const hdr = data?.OpenAPI_ServiceResponse?.cmmMsgHeader;
      if (hdr) { const e = new Error(`API 오류: ${hdr.errMsg}`); e.fatal = true; throw e; }
      return data;
    } catch (e) {
      err = e;
      if (e.fatal || /HTTP 40[13]/.test(e.message)) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw err;
}

async function fetchService([label, url], key, since) {
  const filters = [{ "cond[OPN_ATMY_GRP_CD::EQ]": SEJONG_CODE }, { "cond[ROAD_NM_ADDR::LIKE]": "세종특별자치시" }];
  for (const flt of filters) {
    const out = [];
    for (let page = 1; page < 50; page++) {
      const data = await call(url, key, { numOfRows: 100, pageNo: page, "cond[LCPMT_YMD::GTE]": since, ...flt });
      const body = data?.response?.body || {};
      let items = body.items?.item ?? body.items ?? [];
      if (!Array.isArray(items)) items = [items];
      out.push(...items);
      if (items.length < 100 || out.length >= Number(body.totalCount || 0)) break;
    }
    if (out.length) return out.map(r => ({ ...r, _kind: label }));
  }
  return [];
}

function normalize(r) {
  const name = (r.BPLC_NM || "").trim();
  const btype = (r.SNTTN_BZSTAT_NM || r.BZSTAT_SE_NM || "").trim();
  const road = (r.ROAD_NM_ADDR || "").trim(), lot = (r.LOTNO_ADDR || "").trim();
  if (!(road + lot).includes("세종")) return null;
  if (EXCLUDE_TYPES.has(btype) || EXCLUDE_NAME.test(name)) return null;
  let lat = null, lng = null;
  const x = parseFloat(r.CRD_INFO_X), y = parseFloat(r.CRD_INFO_Y);
  if (x && y) { [lng, lat] = proj4(EPSG5174, "EPSG:4326", [x, y]).map(v => +v.toFixed(6)); }
  const open = (r.LCPMT_YMD || "").replace(/[^0-9]/g, "").slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  const upd = (r.DAT_UPDT_PNT || "").slice(0, 10);
  return {
    id: r.MNG_NO || `${name}|${road}`, name, kind: r._kind, type: btype, genre: genreOf(btype, name),
    status: (r.DTL_SALS_STTS_NM || r.SALS_STTS_NM || "").trim(), open,
    closed: (r.CLSBIZ_YMD || "").trim(), dong: dongOf(road, lot), addr: road || lot,
    tel: (r.TELNO || "").trim(), area: r.LCTN_AREA || "", lat, lng, updated: r.DAT_UPDT_PNT || "",
    // 공공데이터에 새로 등록(I)된 날 = 대시보드가 처음 볼 수 있게 된 날
    first_seen: r.DAT_UPDT_SE === "I" && upd ? upd : open,
  };
}

async function geocode(q) {
  const qs = new URLSearchParams({ q, format: "json", limit: 1, countrycodes: "kr" });
  const r = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, {
    headers: { "User-Agent": "sejong-new-eats/1.0 (github.com/kmskr2000-tech/sejong-new-eats)" },
    signal: AbortSignal.timeout(6000),
  });
  const res = await r.json();
  if (res[0]) {
    const lat = +res[0].lat, lng = +res[0].lon;
    if (lat > 36.3 && lat < 36.8 && lng > 127.0 && lng < 127.5) return [+lat.toFixed(6), +lng.toFixed(6)];
  }
  return null;
}

async function geocodeMissing(places, limit, deadline) {
  for (const p of places) {
    if (p.lat == null && GEO[p.id]) { [p.lat, p.lng] = GEO[p.id]; p.approx = true; }
  }
  let ok = 0, tried = 0;
  for (const p of places.filter(p => p.lat == null).slice(0, limit)) {
    if (Date.now() > deadline) break;
    tried++;
    const road = p.addr.replace(/\(.*?\)/g, "").split(",")[0].trim();
    let hit = null;
    try { hit = await geocode(road); } catch (e) { console.log("geocode 실패", road, e.message); }
    await sleep(1100); // Nominatim 이용 정책: 초당 1회
    if (hit) { [p.lat, p.lng] = hit; p.approx = true; ok++; }
  }
  console.log(`좌표 보충 ${ok}/${tried}`);
}

module.exports = async (req, res) => {
  const t0 = Date.now();
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) { res.status(500).json({ error: "DATA_GO_KR_KEY 미설정", places: [] }); return; }
  const now = new Date(Date.now() + 9 * 3600e3); // KST
  const since = ymd(new Date(now - LOOKBACK_DAYS * 864e5)).replace(/-/g, "");
  const rows = [], failed = [];
  for (const svc of SERVICES) {
    try { rows.push(...await fetchService(svc, key, since)); }
    catch (e) { failed.push(`${svc[0]}: ${e.message}`); }
  }
  if (failed.length === SERVICES.length) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: failed.join(" / "), places: [] });
    return;
  }
  const seen = new Set(), places = [];
  for (const r of rows) {
    const p = normalize(r);
    if (p && !seen.has(p.id)) { seen.add(p.id); places.push(p); }
  }
  console.log(`공공데이터 조회 ${((Date.now() - t0) / 1000).toFixed(1)}초, ${places.length}곳`);
  await geocodeMissing(places, 15, Date.now() + 25000);
  places.sort((a, b) => (b.open + b.first_seen).localeCompare(a.open + a.first_seen));
  res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
  res.status(200).json({
    generated_at: new Date().toISOString(),
    since: `${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6)}`,
    source: "공공데이터포털 행정안전부_식품_일반음식점·휴게음식점 조회서비스",
    failed, count: places.length, places,
  });
};
