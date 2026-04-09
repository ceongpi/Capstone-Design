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

function colorForCrowding(crowding) {
  if (crowding >= 100) return [179, 35, 36, 230];
  if (crowding >= 80) return [216, 73, 65, 220];
  if (crowding >= 60) return [245, 158, 11, 220];
  if (crowding >= 40) return [250, 204, 21, 215];
  return [24, 119, 242, 210];
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function crowdingFromPassengers(passengers, busCapacity) {
  return Number(((passengers / busCapacity) * 100).toFixed(2));
}

function buildViewState(route) {
  const stops = route.stops.filter((stop) => Number.isFinite(stop.stopLat) && Number.isFinite(stop.stopLon));
  const lat = average(stops.map((stop) => stop.stopLat));
  const lon = average(stops.map((stop) => stop.stopLon));
  return {
    latitude: lat,
    longitude: lon,
    zoom: route.routeName === '성북20' ? 13.7 : 12.1,
    pitch: 45,
    bearing: route.routeName === '140' ? 12 : route.routeName === '171' ? -8 : 22,
  };
}

function App() {
  const [dataset, setDataset] = useState(null);
  const [selectedRouteName, setSelectedRouteName] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedHourIndex, setSelectedHourIndex] = useState(3);
  const [selectedStopSequence, setSelectedStopSequence] = useState(null);
  const [viewState, setViewState] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let active = true;

    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error('예측 데이터 파일을 불러오지 못했습니다.');
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

  const selectedStop = useMemo(() => {
    return decoratedStops.find((stop) => stop.sequence === effectiveSelectedStopSequence) ?? decoratedStops[0] ?? null;
  }, [decoratedStops, effectiveSelectedStopSequence]);

  const summary = useMemo(() => {
    if (!selectedRoute || !selectedSnapshot || !selectedStop || !dataset) return null;
    const avgCrowding = average(decoratedStops.map((stop) => stop.crowding));
    const peakStop = decoratedStops.reduce((best, stop) => (stop.crowding > best.crowding ? stop : best), decoratedStops[0]);
    const topStops = [...decoratedStops].sort((a, b) => b.crowding - a.crowding).slice(0, 10);
    const routeSeries = hours.map((hour, index) => ({
      hour,
      crowding: selectedSnapshot.averages[index],
    }));
    const stopSeries = selectedStop.hourlyPassengers.map((passengers, index) => ({
      hour: hours[index],
      passengers,
      crowding: crowdingFromPassengers(passengers, dataset.busCapacity),
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
        data: mappedStops.filter((_, index) => index % Math.ceil(mappedStops.length / 16) === 0),
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
        <div>
          <p className="eyebrow">Capstone Dashboard</p>
          <h1>서울 버스 혼잡도 인터랙티브 맵</h1>
          <p className="subtitle">
            실측 데이터와 요일 기반 미래 예측을 같은 화면에서 비교할 수 있도록 확장했습니다.
            날짜를 바꾸면 노선 전체와 정류장 단위 혼잡도가 함께 갱신됩니다.
          </p>
        </div>
        <div className="hero-metrics">
          <div className="stat-card">
            <span>평균 혼잡도</span>
            <strong>{summary.avgCrowding}%</strong>
            <small>{selectedSnapshot.label}</small>
          </div>
          <div className="stat-card accent">
            <span>최고 혼잡 정류장</span>
            <strong>{summary.peakStop.localStopName}</strong>
            <small>{summary.peakStop.crowding}%</small>
          </div>
        </div>
      </header>

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
            <label htmlFor="dateSelect">날짜</label>
            <select id="dateSelect" value={selectedDate} onChange={handleDateChange}>
              {timeline.map((item) => (
                <option key={item.date} value={item.date}>
                  {item.label}
                </option>
              ))}
            </select>
          </section>

          <section>
            <label htmlFor="hourRange">시간대</label>
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
            <p className="section-title">상위 혼잡 정류장</p>
            <div className="stop-list">
              {summary.topStops.map((stop) => (
                <button
                  key={stop.sequence}
                  className={`stop-chip ${stop.sequence === effectiveSelectedStopSequence ? 'active' : ''}`}
                  onClick={() => setSelectedStopSequence(stop.sequence)}
                  type="button"
                >
                  <span>{stop.sequence}. {stop.localStopName}</span>
                  <strong>{stop.crowding}%</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="legend-block">
            <p className="section-title">예측 모델</p>
            <div className="legend-row"><i className="legend-dot cool" /> {selectedSnapshot.type === 'actual' ? '실측 데이터' : '예측 데이터'}</div>
            <div className="legend-row"><i className="legend-dot mild" /> 학습일수 {dataset.model.trainingDateCount}일</div>
            <div className="legend-row"><i className="legend-dot warm" /> 예측범위 {dataset.model.predictionHorizonDays}일</div>
            <div className="legend-row"><i className="legend-dot hot" /> 요일-시간-정류장 평균 기반</div>
          </section>
        </aside>

        <section className="map-stage glass">
          <div className="map-header">
            <div>
              <p className="section-title">Route View</p>
              <h2>{selectedRoute.routeName} 노선</h2>
            </div>
            <div className="route-meta">
              <span>{selectedRoute.routeId}</span>
              <span>{selectedRoute.stopCountLocal}개 정류장</span>
              <span>{selectedSnapshot.type === 'actual' ? '실측' : '예측'}</span>
            </div>
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
                        <div style="min-width:180px">
                          <strong>${object.sequence}. ${object.localStopName}</strong><br/>
                          날짜: ${selectedSnapshot.label}<br/>
                          시간: ${selectedHour}<br/>
                          재차인원: ${object.passengers}명<br/>
                          혼잡도: ${object.crowding}%
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
      </main>

      <section className="charts-grid">
        <article className="chart-panel glass">
          <div className="panel-head">
            <div>
              <p className="section-title">Route Trend</p>
              <h3>노선 평균 혼잡도</h3>
            </div>
            <span>{selectedSnapshot.label}</span>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={summary.routeSeries}>
                <defs>
                  <linearGradient id="routeGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0b6e4f" stopOpacity={0.45} />
                    <stop offset="95%" stopColor="#0b6e4f" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                <XAxis dataKey="hour" tick={{ fill: '#5f6770', fontSize: 12 }} />
                <YAxis tick={{ fill: '#5f6770', fontSize: 12 }} />
                <Tooltip />
                <Area type="monotone" dataKey="crowding" stroke="#0b6e4f" fill="url(#routeGradient)" strokeWidth={3} />
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
            <span>{selectedStop ? `${selectedStop.sequence}번` : ''}</span>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={summary.stopSeries}>
                <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                <XAxis dataKey="hour" tick={{ fill: '#5f6770', fontSize: 12 }} />
                <YAxis tick={{ fill: '#5f6770', fontSize: 12 }} />
                <Tooltip />
                <Line type="monotone" dataKey="crowding" stroke="#d94841" strokeWidth={3} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {selectedStop ? (
            <p className="stop-caption">
              {selectedSnapshot.label} {selectedHour} 기준 재차인원 {selectedStop.passengers}명, 혼잡도 {selectedStop.crowding}%입니다.
            </p>
          ) : null}
        </article>
      </section>
    </div>
  );
}

export default App;
