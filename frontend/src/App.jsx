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

const HOURS = Array.from({ length: 24 }, (_, index) => `${String((index + 4) % 24).padStart(2, '0')}시`);
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

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

function buildRouteSeries(route) {
  return HOURS.map((hour) => ({
    hour,
    crowding: route.averages[hour],
  }));
}

function buildStopSeries(stop) {
  return HOURS.map((hour) => ({
    hour,
    crowding: stop.hourly[hour].crowding,
    passengers: stop.hourly[hour].passengers,
  }));
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
  const [routes, setRoutes] = useState([]);
  const [selectedRouteName, setSelectedRouteName] = useState('');
  const [selectedHourIndex, setSelectedHourIndex] = useState(3);
  const [selectedStopSequence, setSelectedStopSequence] = useState(null);
  const [viewState, setViewState] = useState(null);

  useEffect(() => {
    let active = true;

    fetch('/data/selected_routes.json')
      .then((response) => response.json())
      .then((json) => {
        if (!active) return;
        setRoutes(json);
        const firstRoute = json[0];
        setSelectedRouteName(firstRoute.routeName);
        setSelectedStopSequence(firstRoute.stops[0]?.sequence ?? null);
        setViewState(buildViewState(firstRoute));
      });

    return () => {
      active = false;
    };
  }, []);

  const selectedRoute = useMemo(
    () => routes.find((route) => route.routeName === selectedRouteName) ?? null,
    [routes, selectedRouteName],
  );

  const selectedHour = HOURS[selectedHourIndex];

  useEffect(() => {
    if (!selectedRoute) return;
    setSelectedStopSequence((current) => {
      const exists = selectedRoute.stops.some((stop) => stop.sequence === current);
      return exists ? current : selectedRoute.stops[0]?.sequence ?? null;
    });
    setViewState(buildViewState(selectedRoute));
  }, [selectedRoute]);

  const selectedStop = useMemo(() => {
    if (!selectedRoute) return null;
    return selectedRoute.stops.find((stop) => stop.sequence === selectedStopSequence) ?? selectedRoute.stops[0] ?? null;
  }, [selectedRoute, selectedStopSequence]);

  const summary = useMemo(() => {
    if (!selectedRoute) return null;
    const stops = selectedRoute.stops;
    const stopCrowding = stops.map((stop) => ({
      ...stop,
      crowding: stop.hourly[selectedHour].crowding,
      passengers: stop.hourly[selectedHour].passengers,
    }));
    const avgCrowding = average(stopCrowding.map((stop) => stop.crowding));
    const peakStop = stopCrowding.reduce((best, stop) => (stop.crowding > best.crowding ? stop : best), stopCrowding[0]);
    return {
      avgCrowding: avgCrowding.toFixed(2),
      peakStop,
      topStops: [...stopCrowding].sort((a, b) => b.crowding - a.crowding).slice(0, 10),
      routeSeries: buildRouteSeries(selectedRoute),
      stopSeries: selectedStop ? buildStopSeries(selectedStop) : [],
    };
  }, [selectedRoute, selectedStop, selectedHour]);

  const layers = useMemo(() => {
    if (!selectedRoute) return [];
    const mappedStops = selectedRoute.stops.filter((stop) => Number.isFinite(stop.stopLat) && Number.isFinite(stop.stopLon));

    return [
      new PathLayer({
        id: `path-${selectedRoute.routeName}`,
        data: [
          {
            path: mappedStops.map((stop) => [stop.stopLon, stop.stopLat]),
          },
        ],
        getPath: (d) => d.path,
        getColor: [12, 110, 79, 230],
        widthUnits: 'pixels',
        getWidth: 7,
        pickable: false,
        rounded: true,
      }),
      new ScatterplotLayer({
        id: `stops-${selectedRoute.routeName}-${selectedHour}`,
        data: mappedStops,
        getPosition: (d) => [d.stopLon, d.stopLat],
        getFillColor: (d) => colorForCrowding(d.hourly[selectedHour].crowding),
        getLineColor: (d) => (d.sequence === selectedStopSequence ? [255, 255, 255, 255] : [26, 33, 42, 180]),
        getRadius: (d) => (d.sequence === selectedStopSequence ? 95 : 68),
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
        data: mappedStops.filter((stop, index) => index % Math.ceil(mappedStops.length / 16) === 0),
        getPosition: (d) => [d.stopLon, d.stopLat],
        getText: (d) => d.localStopName,
        getSize: 13,
        getColor: [42, 49, 57, 220],
        getPixelOffset: [0, 16],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'top',
        billboard: true,
        pickable: false,
      }),
    ];
  }, [selectedRoute, selectedHour, selectedStopSequence]);

  if (!selectedRoute || !summary || !viewState) {
    return <div className="loading">데이터를 불러오는 중입니다.</div>;
  }

  return (
    <div className="app-shell">
      <header className="hero-panel glass">
        <div>
          <p className="eyebrow">Capstone Dashboard</p>
          <h1>서울 버스 혼잡도 인터랙티브 맵</h1>
          <p className="subtitle">
            GTFS 경로 위에 시간대별 정류장 혼잡도를 올리고, 선택한 정류장의 일중 패턴까지 바로 확인할 수 있게 구성했습니다.
          </p>
        </div>
        <div className="hero-metrics">
          <div className="stat-card">
            <span>평균 혼잡도</span>
            <strong>{summary.avgCrowding}%</strong>
            <small>{selectedHour} 기준</small>
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
            <select
              id="routeSelect"
              value={selectedRouteName}
              onChange={(event) => setSelectedRouteName(event.target.value)}
            >
              {routes.map((route) => (
                <option key={route.routeName} value={route.routeName}>
                  {route.routeName}
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
                max={HOURS.length - 1}
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
                  className={`stop-chip ${stop.sequence === selectedStopSequence ? 'active' : ''}`}
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
            <p className="section-title">혼잡도 범례</p>
            <div className="legend-row"><i className="legend-dot cool" /> 40% 미만</div>
            <div className="legend-row"><i className="legend-dot mild" /> 40% 이상</div>
            <div className="legend-row"><i className="legend-dot warm" /> 60% 이상</div>
            <div className="legend-row"><i className="legend-dot hot" /> 80% 이상</div>
            <div className="legend-row"><i className="legend-dot critical" /> 100% 이상</div>
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
                          시간: ${selectedHour}<br/>
                          재차인원: ${object.hourly[selectedHour].passengers}명<br/>
                          혼잡도: ${object.hourly[selectedHour].crowding}%
                        </div>
                      `,
                    }
                  : null
              }
            >
              <Map mapStyle={MAP_STYLE} reuseMaps />
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
            <span>{selectedRoute.routeName}</span>
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
              {selectedHour} 현재 재차인원 {selectedStop.hourly[selectedHour].passengers}명, 혼잡도 {selectedStop.hourly[selectedHour].crowding}%입니다.
            </p>
          ) : null}
        </article>
      </section>
    </div>
  );
}

export default App;
