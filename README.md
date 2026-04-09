# Seoul Bus Crowding Visualization

서울 버스 3개 노선 `140`, `171`, `성북20`의 GTFS 경로와 정류장별 차내 재차인원 데이터를 결합해 시각화하는 프로젝트입니다. 현재는 `2026-03-15`부터 `2026-03-29`까지의 실측 데이터와, 그 이후 `7일`의 베이스라인 예측을 함께 제공합니다.

## 구성

- `frontend/`: React + Vite + deck.gl 프론트엔드
- `scripts/build_gtfs_visualization.js`: CSV와 GTFS를 결합하고 실측/예측 데이터를 생성하는 스크립트
- `frontend/public/data/selected_routes.json`: 프론트엔드에서 사용하는 데이터
- `output/`: 생성된 중간 산출물과 요약 HTML
- `agent.md`: 프로젝트 계획 메모

## 로컬 실행

### 1. 데이터 생성

```powershell
node .\scripts\build_gtfs_visualization.js
```

### 2. 프론트엔드 실행

```powershell
cd .\frontend
npm install
npm.cmd run dev
```

브라우저에서 `http://localhost:5173`로 접속합니다.

## GitHub Pages 배포

이 저장소는 `main` 브랜치에 push되면 GitHub Actions가 자동으로 다음 작업을 수행하도록 설정되어 있습니다.

1. 커밋된 `frontend/public/data/selected_routes.json`을 사용
2. `frontend` 빌드
3. `frontend/dist`를 GitHub Pages에 배포

예상 공개 주소:

`https://ceongpi.github.io/Capstone-Design/`

### GitHub에서 한 번만 해야 하는 설정

1. 저장소의 `Settings`
2. `Pages`
3. `Source`를 `GitHub Actions`로 선택

그 다음부터는 `main`에 push하면 자동 배포됩니다.

### 데이터 갱신 순서

원본 GTFS와 CSV는 저장소에 포함하지 않으므로, 데이터를 바꿀 때는 로컬에서 먼저 아래 순서로 갱신한 뒤 push해야 합니다.

```powershell
node .\scripts\build_gtfs_visualization.js
git add frontend/public/data/selected_routes.json output
git commit -m "Update crowding dataset"
git push origin main
```

## 참고

- 큰 원본 데이터는 저장소에 포함하지 않습니다.
- 제외 항목은 `.gitignore`를 따릅니다.
- 로컬에서 `vite build`가 Windows 샌드박스 제약으로 실패할 수 있으나, GitHub Actions에서는 정상 빌드되도록 배포 워크플로를 추가했습니다.
