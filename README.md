# 세종 새 식당 레이더

세종특별자치시에 새로 인허가 신고된 일반음식점·휴게음식점을 매일 자동으로 수집해 보여주는 대시보드.

- 자료: 공공데이터포털 `행정안전부_식품_일반음식점 조회서비스`, `행정안전부_식품_휴게음식점 조회서비스` (일간 갱신, 약 2일 지연)
- 자동화: GitHub Actions(`.github/workflows/update.yml`)가 매일 07:17·18:17(KST)에 `scripts/fetch.py` 실행 → `data/restaurants.json` 커밋
- 화면: `index.html` (정적 페이지, 목록·지도·주별 추이, 동네·장르·기간 필터, 관심 동네 별표)

## 설정 (최초 1회)
1. `setup/update.yml` 파일을 열고 연필(편집) → 파일 이름칸을 `.github/workflows/update.yml` 로 바꾼 뒤 Commit (자동 실행 등록)
2. Settings › Pages › Branch `main` / `(root)` → Save (웹 공개)
3. data.go.kr에서 위 두 조회서비스 활용신청
4. Settings › Secrets and variables › Actions › New repository secret
   - Name: `DATA_GO_KR_KEY`, Value: 마이페이지의 일반 인증키(Decoding)
5. Actions › `세종 신규 식당 수집` › Run workflow 로 첫 수집

## 메모
- 수집 기간: 인허가일자 기준 최근 365일(`LOOKBACK_DAYS`로 변경)
- 지역 필터: 개방자치단체코드 5690000(세종), 결과가 없으면 도로명주소 '세종특별자치시' 포함 조건으로 재시도
- 좌표: EPSG:5174 → WGS84 변환(pyproj)
- 제외: 편의점, 철도역구내, 출장·이동조리, 대형마트·편의점 상호
- 장르: 위생업태명 + 상호 키워드로 자동 분류(`GENRE_RULES`)
