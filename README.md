# 세종 새 식당 레이더

세종특별자치시에 새로 인허가 신고된 일반음식점·휴게음식점을 자동으로 수집해 보여주는 대시보드.

- 주소: https://sejong-new-eats.vercel.app/
- 자료: 공공데이터포털 `행정안전부_식품_일반음식점 조회서비스`, `행정안전부_식품_휴게음식점 조회서비스` (일간 갱신, 약 2일 지연)

## 구조
- `index.html`: 정적 화면(목록·지도·주별 추이, 동네·장르·기간 필터, 관심 동네 별표)
- `api/data.js`: Vercel 함수. 요청 시 공공데이터 API로 세종(개방자치단체코드 5690000) 최근 1년 인허가를 조회해 JSON 반환
  - CDN 캐시 6시간 + stale-while-revalidate 로 자동 갱신(별도 스케줄러 없음)
  - `vercel.json` 이 `/data/restaurants.json` 요청을 이 함수로 연결
- `api/geo.json`: 공공데이터에 좌표가 없는 곳의 근사 좌표 캐시. 캐시에 없는 곳은 OSM Nominatim 으로 실시간 보충(최대 15곳)
- `scripts/fetch.py`: 같은 수집 로직의 파이썬 버전(로컬 점검·좌표 캐시 생성용)

## 설정
- Vercel 환경변수 `DATA_GO_KR_KEY`: 공공데이터포털 일반 인증키(Decoding)
- `main` 에 푸시하면 Vercel 이 자동 배포

## 메모
- 좌표: EPSG:5174 → WGS84 (proj4, towgs84 포함)
- '새로 잡힘': 공공데이터에 신규 등록(DAT_UPDT_SE=I)된 날짜 기준 최근 3일
- 제외: 편의점, 철도역구내, 출장·이동조리, 대형마트·편의점 상호
- 장르: 위생업태명 + 상호 키워드로 자동 분류(`GENRE_RULES`)
