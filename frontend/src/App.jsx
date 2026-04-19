import { useEffect, useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import Map from 'react-map-gl/maplibre';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';

const EMPTY_ARRAY = [];
const DATA_URL = `${import.meta.env.BASE_URL}data/selected_routes.json`;
const VIEW_MODES = {
  MAP: 'map',
  CHARTS: 'charts',
};

function colorForCrowding(crowding) {
  if (crowding >= 100) return [179, 35, 36, 230];
  if (crowding >= 80) return [216, 73, 65, 220];
  if (crowding >= 60) return [245, 158, 11, 220];
  if (crowding >= 40) return [250, 204, 21, 215];
  return [24, 119, 242, 210];
}

function crowdingLevelLabel(crowding) {
  if (crowding >= 100) return '정원 초과';
  if (crowding >= 80) return '매우 혼잡';
  if (crowding >= 60) return '혼잡';
  if (crowding >= 40) return '보통';
  return '여유';
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function crowdingFromPassengers(passengers, busCapacity) {
  return Number(((passengers / busCapacity) * 100).toFixed(2));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function buildViewState(route) {
  const stops = route.stops.filter((stop) => Number.isFinite(stop.stopLat) && Number.isFinite(stop.stopLon));
  if (!stops.length) {
    return {
      latitude: 37.5665,
      longitude: 126.978,
      zoom: 11.2,
      pitch: 35,
      bearing: 0,
    };
  }

  const latitudes = stops.map((stop) => stop.stopLat);
  const longitudes = stops.map((stop) => stop.stopLon);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const spread = Math.max(maxLat - minLat, maxLon - minLon);

  return {
    latitude: average(latitudes),
    longitude: average(longitudes),
    zoom: clamp(13.8 - Math.log2((spread + 0.002) * 240), 10.6, 14.8),
    pitch: 42,
    bearing: 0,
  };
}

function CustomTooltip({ active, payload, label, unit, title }) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{title}</strong>
      <div>{`시간: ${label}`}</div>
      {payload.map((item) => (
        <div key={item.dataKey}>
          {`${item.name}: ${item.value}${unit}`}
        </div>
      ))}
    </div>
  );
}

function App() {
  const [dataset, setDataset] = useState(null);
  const [selectedRouteName, setSelectedRouteName] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedHourIndex, setSelectedHourIndex] = useState(3);
  const [selectedStopSequence, setSelectedStopSequence] = useState(null);
  const [viewState, setViewState] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [activeView, setActiveView] = useState(VIEW_MODES.MAP);

  useEffect(() => {
    let active = true;

    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error('데이터 파일을 불러오지 못했습니다.');
        }
        return response.json();
      })
      .then((json) => {
        if (!active) return;
        const firstRoute = json.routes[0];
        const initialDate = json.latestActualDate ?? json.timeline[0]?.date ?? '';
        setDataset(json);
        setSelectedRouteName(firstRoute?.routeName ?? '');
        setSelectedDate(initialDate);
        setSelectedStopSequence(firstRoute?.stops[0]?.sequence ?? null);
        setViewState(firstRoute ? buildViewState(firstRoute) : null);
        setErrorMessage('');
      })
      .catch((error) => {
        if (!active) return;
        setErrorMessage(error.message);
      });

    return () => {
      active = false;
    };
  }, []);

  const routes = dataset?.routes ?? EMPTY_ARRAY;
  const hours = dataset?.hours ?? EMPTY_ARRAY;
  const timeline = dataset?.timeline ?? EMPTY_ARRAY;
  const selectedHour = hours[selectedHourIndex] ?? '';

  const selectedRoute = useMemo(
    () => routes.find((route) => route.routeName === selectedRouteName) ?? null,
    [routes, selectedRouteName],
  );

  const selectedSnapshot = useMemo(() => {
    if (!selectedRoute) return null;
    return selectedRoute.snapshots.find((snapshot) => snapshot.date === selectedDate) ?? selectedRoute.snapshots[0] ?? null;
  }, [selectedDate, selectedRoute]);

  const effectiveSelectedStopSequence = useMemo(() => {
    if (!selectedRoute) return null;
    const exists = selectedRoute.stops.some((stop) => stop.sequence === selectedStopSequence);
    return exists ? selectedStopSequence : selectedRoute.stops[0]?.sequence ?? null;
  }, [selectedRoute, selectedStopSequence]);

  const decoratedStops = useMemo(() => {
    if (!selectedRoute || !selectedSnapshot || !dataset) return [];
    return selectedRoute.stops.map((stop, index) => {
      const passengers = selectedSnapshot.stopPassengers[index][selectedHourIndex];
      return {
        ...stop,
        stopIndex: index,
        passengers,
        crowding: crowdingFromPassengers(passengers, dataset.busCapacity),
        hourlyPassengers: selectedSnapshot.stopPassengers[index],
      };
    });
  }, [dataset, selectedHourIndex, selectedRoute, selectedSnapshot]);

  const selectedStop = useMemo(
    () => decoratedStops.find((stop) => stop.sequence === effectiveSelectedStopSequence) ?? decoratedStops[0] ?? null,
    [decoratedStops, effectiveSelectedStopSequence],
  );

  const summary = useMemo(() => {
    if (!selectedRoute || !selectedSnapshot || !selectedStop || !dataset || !decoratedStops.length) return null;

    const avgCrowding = average(decoratedStops.map((stop) => stop.crowding));
    const peakStop = decoratedStops.reduce((best, stop) => (stop.crowding > best.crowding ? stop : best), decoratedStops[0]);
    const topStops = [...decoratedStops].sort((a, b) => b.crowding - a.crowding).slice(0, 10);
    const routeSeries = hours.map((hour, index) => ({
      hour,
      혼잡도: selectedSnapshot.averages[index],
    }));
    const stopSeries = selectedStop.hourlyPassengers.map((passengers, index) => ({
      hour: hours[index],
      재차인원: passengers,
      혼잡도: crowdingFromPassengers(passengers, dataset.busCapacity),
    }));

    return {
      avgCrowding: avgCrowding.toFixed(2),
      peakStop,
      topStops,
      routeSeries,
      stopSeries,
    };
  }, [dataset, decoratedStops, hours, selectedRoute, selectedSnapshot, selectedStop]);

  const layers = useMemo(() => {
    if (!selectedRoute) return [];
    const mappedStops = decoratedStops.filter((stop) => Number.isFinite(stop.stopLat) && Number.isFinite(stop.stopLon));

    return [
      new PathLayer({
        id: `path-${selectedRoute.routeName}`,
        data: [
          {
            path: mappedStops.map((stop) => [stop.stopLon, stop.stopLat]),
          },
        ],
        getPath: (item) => item.path,
        getColor: [12, 110, 79, 230],
        widthUnits: 'pixels',
        getWidth: 7,
        pickable: false,
        rounded: true,
      }),
      new ScatterplotLayer({
        id: `stops-${selectedRoute.routeName}-${selectedDate}-${selectedHour}`,
        data: mappedStops,
        getPosition: (stop) => [stop.stopLon, stop.stopLat],
        getFillColor: (stop) => colorForCrowding(stop.crowding),
        getLineColor: (stop) =>
          stop.sequence === effectiveSelectedStopSequence ? [255, 255, 255, 255] : [26, 33, 42, 180],
        getRadius: (stop) => (stop.sequence === effectiveSelectedStopSequence ? 95 : 68),
        radiusUnits: 'meters',
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        stroked: true,
        filled: true,
        pickable: true,
        autoHighlight: true,
        onClick: ({ object }) => {
          if (object) setSelectedStopSequence(object.sequence);
        },
      }),
      new TextLayer({
        id: `labels-${selectedRoute.routeName}`,
        data: mappedStops.filter((_, index) => index % Math.max(1, Math.ceil(mappedStops.length / 16)) === 0),
        getPosition: (stop) => [stop.stopLon, stop.stopLat],
        getText: (stop) => stop.localStopName,
        getSize: 13,
        getColor: [42, 49, 57, 220],
        getPixelOffset: [0, 16],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'top',
        billboard: true,
        pickable: false,
      }),
    ];
  }, [decoratedStops, effectiveSelectedStopSequence, selectedDate, selectedHour, selectedRoute]);

  function handleRouteChange(event) {
    const nextRouteName = event.target.value;
    const nextRoute = routes.find((route) => route.routeName === nextRouteName);
    setSelectedRouteName(nextRouteName);
    setSelectedStopSequence(nextRoute?.stops[0]?.sequence ?? null);
    setViewState(nextRoute ? buildViewState(nextRoute) : null);
  }

  function handleDateChange(event) {
    setSelectedDate(event.target.value);
  }

  if (errorMessage) {
    return <div className="loading">{errorMessage}</div>;
  }

  if (!dataset || !selectedRoute || !selectedSnapshot || !summary || !viewState) {
    return <div className="loading">데이터를 불러오는 중입니다.</div>;
  }

  return (
    <div className="app-shell">
      <header className="hero-panel glass">
        <div className="hero-copy">
          <p className="eyebrow">USER-CENTERED BUS INSIGHT</p>
          <h1>버스 혼잡도 한눈에 보기</h1>
          <p className="subtitle">
            혼잡 시간대와 구간별 혼잡도를 빠르게 확인할 수 있도록 구성했습니다.
          </p>
          <div className="value-points">
            <article className="value-card">
              <strong>탑승 전 확인</strong>
              <p>시간대별 혼잡도 확인</p>
            </article>
            <article className="value-card">
              <strong>구간 비교</strong>
              <p>정류장별 혼잡도 비교</p>
            </article>
            <article className="value-card">
              <strong>실측예측 연계</strong>
              <p>실측과 요일별 예측 비교</p>
            </article>
          </div>
        </div>

        <div className="hero-metrics">
          <div className="stat-card">
            <span>현재 선택 노선 평균 혼잡도</span>
            <strong>{summary.avgCrowding}%</strong>
            <small>{selectedSnapshot.label}</small>
          </div>
          <div className="stat-card accent">
            <span>현재 시간대 최고 혼잡 정류장</span>
            <strong>{summary.peakStop.localStopName}</strong>
            <small>{summary.peakStop.crowding}%</small>
          </div>
          <div className="stat-card dark">
            <span>혼잡도 정의</span>
            <strong>{`재차인원 / 정원 ${dataset.busCapacity}명 × 100`}</strong>
            <small>정류장별 시간대 재차인원을 버스 정원 기준 백분율로 환산</small>
          </div>
        </div>
      </header>

      <section className="info-strip">
        <article className="definition-panel glass">
          <p className="section-title">혼잡도 기준</p>
          <h2>혼잡도는 재차인원을 버스 정원 45명 기준으로 계산한 비율입니다.</h2>
          <p><strong>공식</strong></p>
          <p>
            <strong>혼잡도(%) = (재차인원 / 45) × 100</strong>
          </p>
          <p><strong>해석 기준</strong></p>
          <p className="definition-note">100%: 버스 정원 45명과 같은 수준</p>
          <p className="definition-note">100% 초과: 정원을 넘는 혼잡 상태</p>
        </article>

        <article className="definition-panel glass">
          <p className="section-title">데이터 읽는 법</p>
          <ul className="guide-list">
            <li>지도: 선택한 시간대의 정류장별 혼잡도를 색으로 보여줍니다.</li>
            <li>노선 평균 그래프: 시간대별 전체 노선 평균 혼잡도입니다.</li>
            <li>정류장 그래프: 선택한 정류장의 시간대별 재차인원과 혼잡도입니다.</li>
            <li>실측/예측 표시는 현재 선택 날짜가 실제 데이터인지 예측 데이터인지 구분합니다.</li>
          </ul>
        </article>
      </section>

      <main className="workspace">
        <aside className="side-panel glass">
          <section>
            <label htmlFor="routeSelect">노선 선택</label>
            <select id="routeSelect" value={selectedRouteName} onChange={handleRouteChange}>
              {routes.map((route) => (
                <option key={route.routeName} value={route.routeName}>
                  {route.routeName}
                </option>
              ))}
            </select>
          </section>

          <section>
            <label htmlFor="dateSelect">날짜 선택</label>
            <select id="dateSelect" value={selectedDate} onChange={handleDateChange}>
              {timeline.map((item) => (
                <option key={`${item.date}-${item.type}`} value={item.date}>
                  {item.label}
                </option>
              ))}
            </select>
          </section>

          <section>
            <label htmlFor="hourRange">시간대 선택</label>
            <div className="range-row">
              <span>{selectedHour}</span>
              <input
                id="hourRange"
                type="range"
                min="0"
                max={hours.length - 1}
                value={selectedHourIndex}
                onChange={(event) => setSelectedHourIndex(Number(event.target.value))}
              />
            </div>
          </section>

          <section>
            <p className="section-title">분석 화면 전환</p>
            <div className="tab-switch">
              <button
                className={`tab-button ${activeView === VIEW_MODES.MAP ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveView(VIEW_MODES.MAP)}
              >
                지도 보기
              </button>
              <button
                className={`tab-button ${activeView === VIEW_MODES.CHARTS ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveView(VIEW_MODES.CHARTS)}
              >
                그래프 보기
              </button>
            </div>
          </section>

          <section>
            <p className="section-title">상위 혼잡 정류장</p>
            <div className="stop-list">
              {summary.topStops.map((stop) => (
                <button
                  key={stop.sequence}
                  className={`stop-chip ${stop.sequence === effectiveSelectedStopSequence ? 'active' : ''}`}
                  onClick={() => setSelectedStopSequence(stop.sequence)}
                  type="button"
                >
                  <span>{`${stop.sequence}. ${stop.localStopName}`}</span>
                  <strong>{`${stop.crowding}%`}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="legend-block">
            <p className="section-title">현재 해석</p>
            <div className="legend-row"><i className="legend-dot cool" /> {selectedSnapshot.type === 'actual' ? '실측 데이터' : '예측 데이터'}</div>
            <div className="legend-row"><i className="legend-dot mild" /> 선택 시간 혼잡도 단계: {crowdingLevelLabel(summary.peakStop.crowding)}</div>
            <div className="legend-row"><i className="legend-dot warm" /> 학습일수 {dataset.model.trainingDateCount}일</div>
            <div className="legend-row"><i className="legend-dot hot" /> 예측범위 {dataset.model.predictionHorizonDays}일</div>
          </section>
        </aside>

        <section className="content-panel">
          <div className="view-header glass">
            <div>
              <p className="section-title">{activeView === VIEW_MODES.MAP ? 'Map View' : 'Chart View'}</p>
              <h2>{selectedRoute.routeName} 노선</h2>
            </div>
            <div className="route-meta">
              <span>{selectedRoute.routeId}</span>
              <span>{`정류장 ${selectedRoute.stopCountLocal}개`}</span>
              <span>{selectedSnapshot.label}</span>
            </div>
          </div>

          <section className={`map-stage glass ${activeView === VIEW_MODES.MAP ? '' : 'view-hidden'}`}>
            <div className="panel-head">
              <div>
                <p className="section-title">지도 시각화</p>
                <h3>정류장 위치와 시간대별 혼잡도를 동시에 확인</h3>
              </div>
            </div>
            <div className="map-legend">
              <span><i className="legend-dot cool" /> 0~39% 여유</span>
              <span><i className="legend-dot mild" /> 40~59% 보통</span>
              <span><i className="legend-dot warm" /> 60~79% 혼잡</span>
              <span><i className="legend-dot hot" /> 80~99% 매우 혼잡</span>
              <span><i className="legend-dot critical" /> 100% 이상 정원 초과</span>
            </div>
            <div className="map-frame">
              <DeckGL
                controller
                layers={layers}
                viewState={viewState}
                onViewStateChange={({ viewState: nextViewState }) => setViewState(nextViewState)}
                getTooltip={({ object }) =>
                  object
                    ? {
                        html: `
                          <div style="min-width:190px">
                            <strong>${object.sequence}. ${object.localStopName}</strong><br/>
                            날짜: ${selectedSnapshot.label}<br/>
                            시간: ${selectedHour}<br/>
                            재차인원: ${object.passengers}명<br/>
                            혼잡도: ${object.crowding}%<br/>
                            해석: ${crowdingLevelLabel(object.crowding)}
                          </div>
                        `,
                      }
                    : null
                }
              >
                <Map mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" reuseMaps />
              </DeckGL>
            </div>
          </section>

          <section className={`charts-stack ${activeView === VIEW_MODES.CHARTS ? '' : 'view-hidden'}`}>
            <article className="chart-panel glass">
              <div className="panel-head">
                <div>
                  <p className="section-title">Route Trend</p>
                  <h3>노선 평균 혼잡도 그래프</h3>
                </div>
                <span>Y축: 혼잡도(%) / X축: 시간대</span>
              </div>
              <p className="chart-description">
                선택한 노선의 전체 정류장을 평균했을 때 시간대별 혼잡도가 어떻게 변하는지 보여줍니다.
              </p>
              <div className="chart-box">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={summary.routeSeries} margin={{ top: 12, right: 20, left: 8, bottom: 18 }}>
                    <defs>
                      <linearGradient id="routeGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0b6e4f" stopOpacity={0.45} />
                        <stop offset="95%" stopColor="#0b6e4f" stopOpacity={0.03} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                    <XAxis
                      dataKey="hour"
                      tick={{ fill: '#5f6770', fontSize: 12 }}
                      label={{ value: '시간대', position: 'insideBottom', offset: -8 }}
                    />
                    <YAxis
                      tick={{ fill: '#5f6770', fontSize: 12 }}
                      label={{ value: '혼잡도(%)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={<CustomTooltip title="노선 평균 혼잡도" unit="%" />} />
                    <Area type="monotone" dataKey="혼잡도" name="혼잡도" stroke="#0b6e4f" fill="url(#routeGradient)" strokeWidth={3} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="chart-panel glass emphasis">
              <div className="panel-head">
                <div>
                  <p className="section-title">Stop Trend</p>
                  <h3>{selectedStop?.localStopName ?? '정류장 선택'}</h3>
                </div>
                <span>{`Y축: 재차인원(명) / X축: 시간대`}</span>
              </div>
              <p className="chart-description">
                선택한 정류장에서 시간대별 재차인원이 어떻게 변하는지 보여줍니다. 혼잡도 정의는 정원 45명 기준입니다.
              </p>
              <div className="chart-box">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={summary.stopSeries} margin={{ top: 12, right: 20, left: 8, bottom: 18 }}>
                    <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                    <XAxis
                      dataKey="hour"
                      tick={{ fill: '#5f6770', fontSize: 12 }}
                      label={{ value: '시간대', position: 'insideBottom', offset: -8 }}
                    />
                    <YAxis
                      tick={{ fill: '#5f6770', fontSize: 12 }}
                      label={{ value: '재차인원(명)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip content={<CustomTooltip title="정류장 시간대별 재차인원" unit="명" />} />
                    <Line type="monotone" dataKey="재차인원" name="재차인원" stroke="#d94841" strokeWidth={3} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {selectedStop ? (
                <p className="stop-caption">
                  {`${selectedSnapshot.label} ${selectedHour} 기준 ${selectedStop.localStopName} 정류장의 재차인원은 ${selectedStop.passengers}명이고, 혼잡도는 ${selectedStop.crowding}%입니다.`}
                </p>
              ) : null}
            </article>
          </section>
        </section>
      </main>
    </div>
  );
}

export default App;
