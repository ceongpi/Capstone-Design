# Seoul Bus Crowding Visualization

서울 버스 스마트카드 재차인원 CSV와 GTFS를 결합해 노선별 혼잡도를 시각화하는 프로젝트입니다. 현재 빌드 스크립트는 폴더에 있는 CSV 파일을 자동으로 스캔해 대상 노선을 결정하며, 실측 데이터 뒤에 7일치 베이스라인 예측을 생성합니다.

현재 워크스페이스 기준 원본 CSV는 `2026-03-22`부터 `2026-04-05`까지 15일치입니다.

## 구성

- `frontend/`: React + Vite + deck.gl 프론트엔드
- `scripts/build_gtfs_visualization.js`: CSV와 GTFS를 결합해 실측/예측 데이터를 생성하는 스크립트
- `frontend/public/data/selected_routes.json`: 프론트엔드에서 사용하는 데이터
- `output/`: 생성된 중간 산출물과 요약 HTML
- `agent.md`: 프로젝트 메모

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

## 데이터 갱신

CSV 파일을 교체한 뒤 아래 명령으로 산출물을 다시 생성합니다.

```powershell
node .\scripts\build_gtfs_visualization.js
```

생성 결과는 다음 파일에 반영됩니다.

- `output/selected_routes.json`
- `frontend/public/data/selected_routes.json`
- `output/seoul_gtfs_routes.csv`
- `output/seoul_gtfs_trips.csv`
- `output/seoul_gtfs_stop_times.csv`
- `output/seoul_gtfs_stops.csv`
- `output/seoul_bus_visualization.html`

## 배포

GitHub Pages와 Vercel 모두 `frontend` 빌드 결과를 배포 대상으로 사용합니다.

### GitHub Pages

`main` 브랜치에 push하면 GitHub Actions가 `frontend`를 빌드해 Pages로 배포합니다.

공개 주소:

`https://ceongpi.github.io/Capstone-Design/`

### Vercel

- Framework Preset: `Vite`
- Root Directory: `frontend`
- Build Command: `npm run build`
- Output Directory: `dist`
