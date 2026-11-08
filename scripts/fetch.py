"""세종시 신규 음식점 수집기.

공공데이터포털 '행정안전부_식품_일반음식점/휴게음식점 조회서비스'에서
세종특별자치시 인허가 데이터를 받아 data/restaurants.json 을 갱신한다.

환경변수:
  DATA_GO_KR_KEY  공공데이터포털 일반 인증키(Decoding)
  LOOKBACK_DAYS   인허가일자 기준 수집 기간(기본 365일)
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "restaurants.json"
KST = dt.timezone(dt.timedelta(hours=9))

SERVICES = {
    "general": ("일반음식점", "https://apis.data.go.kr/1741000/general_restaurants/info"),
    "rest": ("휴게음식점", "https://apis.data.go.kr/1741000/rest_cafes/info"),
}
SEJONG_CODE = "5690000"  # 개방자치단체코드: 세종특별자치시

# 인허가 데이터 좌표계(EPSG:5174, 보정계수 없는 Bessel 중부원점TM) -> WGS84
TO_WGS84 = Transformer.from_crs(
    "+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 "
    "+ellps=bessel +units=m +no_defs "
    "+towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43",
    "EPSG:4326",
    always_xy=True,
)

# 프랜차이즈 편의점 등 '식당'이 아닌 휴게음식점 제외용
EXCLUDE_TYPES = {"편의점", "철도역구내", "유원지", "출장조리", "이동조리"}
EXCLUDE_NAME = re.compile(r"(GS25|지에스25|CU|씨유|세븐일레븐|이마트24|미니스톱|홈플러스|이마트\b|롯데마트)", re.I)

GENRE_RULES = [  # (장르, 위생업태명 키워드, 상호 키워드)
    ("카페·디저트", ["까페", "커피", "다방", "제과", "아이스크림", "떡카페", "전통찻집", "키즈카페"],
     ["카페", "커피", "베이커리", "제과", "디저트", "케이크", "브레드", "빵", "젤라또", "티하우스"]),
    ("술집", ["호프", "정종", "대포집", "소주방", "감성주점", "라이브카페", "룸살롱"],
     ["포차", "주점", "이자카야", "호프", "와인", "펍", "비어", "맥주", "술집", "바$", " bar", "하이볼"]),
    ("치킨", ["통닭", "치킨"], ["치킨", "통닭"]),
    ("고기구이", ["식육", "숯불구이"],
     ["갈비", "삼겹", "고기", "한우", "정육", "곱창", "막창", "숯불", "목살", "돼지", "양꼬치", "족발", "보쌈"]),
    ("일식", ["일식", "횟집", "회집"],
     ["스시", "초밥", "오마카세", "돈카츠", "돈까스", "돈가스", "라멘", "우동", "소바", "이자카야", "덮밥", "텐동", "카레", "횟집", "회센터", "사시미"]),
    ("중식", ["중국식"], ["반점", "짬뽕", "짜장", "마라", "훠궈", "중화", "딤섬", "탕후루"]),
    ("양식", ["경양식", "패밀리레스트랑", "패밀리레스토랑"],
     ["파스타", "피자", "스테이크", "브런치", "버거", "비스트로", "트라토리아", "키친"]),
    ("아시아", ["외국음식"], ["쌀국수", "베트남", "타이", "태국", "인도", "커리", "포 ", "분짜", "멕시"]),
    ("분식·간편식", ["분식", "김밥", "패스트푸드", "일반조리판매", "도시락"],
     ["김밥", "떡볶이", "분식", "토스트", "샌드위치", "샐러드", "도시락", "핫도그", "만두", "버거"]),
    ("국밥·면", ["냉면", "탕류"],
     ["국밥", "해장", "설렁탕", "곰탕", "순대", "국수", "칼국수", "냉면", "막국수", "감자탕", "추어탕", "삼계탕", "백숙"]),
    ("한식", ["한식", "뷔페"], ["한식", "백반", "식당", "밥상", "찌개", "정식", "쌈밥", "한정식", "보리밥", "닭갈비", "찜닭", "아구", "아귀"]),
]


def genre_of(btype: str, name: str) -> str:
    btype = btype or ""
    for genre, types, _ in GENRE_RULES:
        if any(t in btype for t in types):
            # 업태가 '한식'이어도 상호가 더 구체적이면 상호 우선
            if genre == "한식":
                break
            return genre
    for genre, _, words in GENRE_RULES:
        if any(re.search(w, name, re.I) for w in words):
            return genre
    if "한식" in btype or "뷔페" in btype:
        return "한식"
    return "기타"


def dong_of(road: str, lot: str) -> str:
    m = re.search(r"\(([^)]*?(동|읍|면|리))[,)]", road or "")
    if m:
        return m.group(1).split(",")[0].strip()
    parts = (lot or "").split()
    for p in parts[1:3]:
        if re.search(r"(동|읍|면)$", p):
            return p
    return "기타"


def call(url: str, key: str, params: dict) -> dict:
    q = {"serviceKey": key, "returnType": "json", **params}
    full = url + "?" + urllib.parse.urlencode(q, safe="[]:")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(full, timeout=60) as r:
                body = r.read().decode("utf-8")
            data = json.loads(body)
            hdr = data.get("OpenAPI_ServiceResponse", {}).get("cmmMsgHeader")
            if hdr:
                raise RuntimeError(f"API 오류: {hdr.get('errMsg')} / {hdr.get('returnAuthMsg')}")
            return data
        except RuntimeError:
            raise
        except Exception as e:  # 네트워크 일시 오류 재시도
            if attempt == 3:
                raise
            print(f"  재시도 {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    return {}


def find_items(obj):
    """응답 구조가 바뀌어도 레코드 목록(dict 리스트)을 찾아낸다."""
    if isinstance(obj, list) and obj and isinstance(obj[0], dict) and "BPLC_NM" in obj[0]:
        return obj
    if isinstance(obj, dict):
        if "BPLC_NM" in obj:
            return [obj]
        for v in obj.values():
            r = find_items(v)
            if r is not None:
                return r
    if isinstance(obj, list):
        for v in obj:
            r = find_items(v)
            if r is not None:
                return r
    return None


def find_total(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() in ("totalcount", "total_count"):
                return int(v)
            r = find_total(v)
            if r is not None:
                return r
    return None


def fetch_service(kind: str, key: str, since: str) -> list:
    label, url = SERVICES[kind]
    out, page = [], 1
    base = {"numOfRows": 100, f"cond[LCPMT_YMD::GTE]": since}
    filters = [{"cond[OPN_ATMY_GRP_CD::EQ]": SEJONG_CODE},
               {"cond[ROAD_NM_ADDR::LIKE]": "세종특별자치시"}]
    for flt in filters:
        out, page = [], 1
        while True:
            data = call(url, key, {**base, **flt, "pageNo": page})
            items = find_items(data) or []
            out.extend(items)
            total = find_total(data)
            print(f"  {label} p{page}: {len(items)}건 (총 {total})")
            if not items or (total is not None and len(out) >= total) or len(items) < 100:
                break
            page += 1
            time.sleep(0.3)
        if out:
            break
        print(f"  {label}: 자치단체코드 조회 결과 없음 -> 주소 조건으로 재시도")
    return [dict(r, _kind=label) for r in out]


def normalize(r: dict) -> dict | None:
    name = (r.get("BPLC_NM") or "").strip()
    btype = (r.get("SNTTN_BZSTAT_NM") or r.get("BZSTAT_SE_NM") or "").strip()
    road = (r.get("ROAD_NM_ADDR") or "").strip()
    lot = (r.get("LOTNO_ADDR") or "").strip()
    if "세종" not in (road + lot):
        return None
    if btype in EXCLUDE_TYPES or EXCLUDE_NAME.search(name):
        return None
    lat = lng = None
    try:
        x, y = float(r.get("CRD_INFO_X") or 0), float(r.get("CRD_INFO_Y") or 0)
        if x and y:
            lng, lat = TO_WGS84.transform(x, y)
            lng, lat = round(lng, 6), round(lat, 6)
    except ValueError:
        pass
    ymd = (r.get("LCPMT_YMD") or "").replace("-", "")[:8]
    return {
        "id": r.get("MNG_NO") or f"{name}|{road}",
        "name": name,
        "kind": r["_kind"],
        "type": btype,
        "genre": genre_of(btype, name),
        "status": (r.get("DTL_SALS_STTS_NM") or r.get("SALS_STTS_NM") or "").strip(),
        "open": f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}" if len(ymd) == 8 else "",
        "closed": (r.get("CLSBIZ_YMD") or "").strip(),
        "dong": dong_of(road, lot),
        "addr": road or lot,
        "tel": (r.get("TELNO") or "").strip(),
        "area": r.get("LCTN_AREA") or "",
        "lat": lat,
        "lng": lng,
        "updated": r.get("DAT_UPDT_PNT") or r.get("LAST_MDFCN_PNT") or "",
    }


def main():
    key = os.environ.get("DATA_GO_KR_KEY", "").strip()
    if not key:
        sys.exit("DATA_GO_KR_KEY 가 없습니다. GitHub 저장소 Settings > Secrets 에 등록하세요.")
    days = int(os.environ.get("LOOKBACK_DAYS", "365"))
    now = dt.datetime.now(KST)
    since = (now - dt.timedelta(days=days)).strftime("%Y%m%d")

    old = {}
    if OUT.exists():
        prev = json.loads(OUT.read_text(encoding="utf-8"))
        old = {p["id"]: p for p in prev.get("places", [])}

    rows = []
    for kind in SERVICES:
        print(f"[{SERVICES[kind][0]}] 인허가일자 {since} 이후 수집")
        rows += fetch_service(kind, key, since)

    today = now.strftime("%Y-%m-%d")
    places, seen = [], set()
    for r in rows:
        p = normalize(r)
        if not p or p["id"] in seen:
            continue
        seen.add(p["id"])
        p["first_seen"] = old.get(p["id"], {}).get("first_seen", today if old else p["open"] or today)
        places.append(p)
    places.sort(key=lambda p: (p["open"], p["first_seen"]), reverse=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated_at": now.isoformat(timespec="seconds"),
        "since": f"{since[:4]}-{since[4:6]}-{since[6:]}",
        "source": "공공데이터포털 행정안전부_식품_일반음식점·휴게음식점 조회서비스",
        "count": len(places),
        "places": places,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    new_today = sum(1 for p in places if p["first_seen"] == today and old)
    print(f"완료: {len(places)}곳 (오늘 새로 잡힌 곳 {new_today})")


if __name__ == "__main__":
    main()
