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
const LLM_ACTION = 'travel_recommendation';

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

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function parseHourLabel(hourLabel) {
  const match = String(hourLabel).match(/\d{1,2}/);
  return match ? Number(match[0]) : null;
}

function parsePreferredHour(query, hours) {
  const match = String(query).match(/(오전|오후)?\s*(\d{1,2})\s*시/);
  if (!match) {
    return null;
  }

  const meridiem = match[1] ?? '';
  const rawHour = Number(match[2]);
  let hour = rawHour;

  if (meridiem === '오후' && rawHour < 12) {
    hour = rawHour + 12;
  } else if (meridiem === '오전' && rawHour === 12) {
    hour = 0;
  } else if (!meridiem && rawHour <= 4) {
    hour = rawHour + 12;
  }

  const exactIndex = hours.findIndex((item) => parseHourLabel(item) === hour);
  if (exactIndex >= 0) {
    return { hour, hourIndex: exactIndex };
  }

  const fallbackIndex = hours.findIndex((item) => parseHourLabel(item) === rawHour);
  return fallbackIndex >= 0 ? { hour: rawHour, hourIndex: fallbackIndex } : null;
}

function collectMentionedStops(query, routes) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return [];
  }

  const mentions = [];
  const seen = new Set();

  routes.forEach((route) => {
    route.stops.forEach((stop) => {
      const stopName = stop.localStopName ?? '';
      const normalizedStopName = normalizeText(stopName);
      if (!normalizedStopName || normalizedStopName.length < 2) {
        return;
      }

      if (normalizedQuery.includes(normalizedStopName)) {
        const key = `${route.routeName}:${stop.sequence}`;
        if (!seen.has(key)) {
          seen.add(key);
          mentions.push({
            routeName: route.routeName,
            sequence: stop.sequence,
            stopName,
            normalizedStopName,
          });
        }
      }
    });
  });

  return mentions;
}

function collectMentionedRouteNames(query, routes) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return [];
  }

  return routes
    .filter((route) => normalizedQuery.includes(normalizeText(route.routeName)))
    .map((route) => route.routeName);
}

function buildTravelCandidates({ routes, selectedDate, hours, busCapacity, query, selectedRouteName, departureStop, destinationStop }) {
  const preferredHour = parsePreferredHour(query, hours);
  
  const normDep = normalizeText(departureStop);
  const normDest = normalizeText(destinationStop);
  const mentionedStopNames = [];
  if (departureStop) mentionedStopNames.push(departureStop);
  if (destinationStop) mentionedStopNames.push(destinationStop);
  const mentionedRouteNames = [];

  const routeCandidates = routes
    .map((route) => {
      const snapshot = route.snapshots.find((item) => item.date === selectedDate) ?? route.snapshots[0] ?? null;
      if (!snapshot) return null;

      const originMentions = route.stops.filter(stop => {
        const norm = normalizeText(stop.localStopName);
        return norm && norm.length >= 2 && (normDep.includes(norm) || norm.includes(normDep));
      });
      
      const destMentions = route.stops.filter(stop => {
        const norm = normalizeText(stop.localStopName);
        return norm && norm.length >= 2 && (normDest.includes(norm) || norm.includes(normDest));
      });

      if (!originMentions.length || !destMentions.length) return null;

      let bestPair = null;
      for (const o of originMentions) {
        for (const d of destMentions) {
          if (o.sequence < d.sequence) {
            if (!bestPair || (d.sequence - o.sequence < bestPair.d.sequence - bestPair.o.sequence)) {
              bestPair = { o, d };
            }
          }
        }
      }

      if (!bestPair) return null;
      const originStop = bestPair.o;
      const destinationStop = bestPair.d;

      let bestOption = null;

      hours.forEach((hourLabel, hourIndex) => {
        const routeCrowding = Number(snapshot.averages[hourIndex] ?? 0);
        const originPassengers = Number(snapshot.stopPassengers[originStop.sequence - 1]?.[hourIndex] ?? 0);
        const destinationPassengers = Number(snapshot.stopPassengers[destinationStop.sequence - 1]?.[hourIndex] ?? 0);
        const originCrowding = crowdingFromPassengers(originPassengers, busCapacity);
        const destinationCrowding = crowdingFromPassengers(destinationPassengers, busCapacity);
        const proximityPenalty = preferredHour ? Math.abs(hourIndex - preferredHour.hourIndex) * 5 : 0;
        const explicitRouteBoost = 0;
        const score =
          routeCrowding * 0.45 +
          originCrowding * 0.4 +
          destinationCrowding * 0.15 +
          proximityPenalty +
          explicitRouteBoost;

        const option = {
          routeName: route.routeName,
          routeId: route.routeId,
          originStopName: originStop.localStopName,
          destinationStopName: destinationStop.localStopName,
          originSequence: originStop.sequence,
          destinationSequence: destinationStop.sequence,
          hour: hourLabel,
          hourIndex,
          routeCrowding,
          originCrowding,
          destinationCrowding,
          score: Number(score.toFixed(2)),
        };

        if (!bestOption || option.score < bestOption.score) {
          bestOption = option;
        }
      });

      return bestOption;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  const fallbackRoute = routes.find((route) => route.routeName === selectedRouteName) ?? routes[0] ?? null;

  return {
    query,
    preferredHour,
    mentionedRouteNames,
    mentionedStopNames,
    candidateCount: routeCandidates.length,
    routeOptions: routeCandidates.slice(0, 5),
    fallbackRoute: fallbackRoute
      ? {
          routeName: fallbackRoute.routeName,
          routeId: fallbackRoute.routeId,
          stopCount: fallbackRoute.stopCountLocal,
        }
      : null,
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

function formatPercent(value) {
  return `${Number(value).toFixed(2)}%`;
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
  const [departureStop, setDepartureStop] = useState('');
  const [destinationStop, setDestinationStop] = useState('');
  const [travelTime, setTravelTime] = useState('');

  const travelPrompt = (departureStop.trim() && destinationStop.trim() && travelTime.trim())
    ? `난 ${travelTime}시에 ${departureStop} 정류장에서 버스를 타고 ${destinationStop}까지 갈 거야.`
    : '';
  const [llmLoadingAction, setLlmLoadingAction] = useState('');
  const [llmError, setLlmError] = useState('');
  const [llmResponse, setLlmResponse] = useState(null);

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
      crowding: selectedSnapshot.averages[index],
      averagePassengers: selectedSnapshot.averagePassengers[index],
    }));
    const stopSeries = selectedStop.hourlyPassengers.map((passengers, index) => ({
      hour: hours[index],
      passengers,
      crowding: crowdingFromPassengers(passengers, dataset.busCapacity),
    }));
    const quietHours = [...routeSeries].sort((a, b) => a.crowding - b.crowding).slice(0, 3);
    const comparisonHour = quietHours.find((entry) => entry.hour !== hours[selectedHourIndex]) ?? quietHours[0] ?? routeSeries[0];
    const peakHour = routeSeries.reduce((best, item) => (item.crowding > best.crowding ? item : best), routeSeries[0]);

    return {
      avgCrowding: avgCrowding.toFixed(2),
      peakStop,
      topStops,
      routeSeries,
      stopSeries,
      quietHours,
      comparisonHour,
      peakHour,
    };
  }, [dataset, decoratedStops, hours, selectedHourIndex, selectedRoute, selectedSnapshot, selectedStop]);

  const travelCandidates = useMemo(() => {
    if (!dataset || !travelPrompt.trim()) {
      return null;
    }

    return buildTravelCandidates({
      routes,
      selectedDate,
      hours,
      busCapacity: dataset.busCapacity,
      query: travelPrompt,
      selectedRouteName,
      departureStop,
      destinationStop,
    });
  }, [dataset, hours, routes, selectedDate, selectedRouteName, travelPrompt, departureStop, destinationStop]);

  const llmPayload = useMemo(() => {
    if (!dataset || !summary || !travelCandidates) {
      return null;
    }

    return {
      type: 'travel_recommendation',
      userQuery: travelPrompt,
      forecast: {
        date: selectedDate,
        label: timeline.find((item) => item.date === selectedDate)?.label ?? selectedDate,
        selectedHour,
        latestActualDate: dataset.latestActualDate,
        model: dataset.model,
      },
      currentSelection: {
        routeName: selectedRoute?.routeName ?? '',
        stopName: selectedStop?.localStopName ?? '',
        stopCrowding: selectedStop?.crowding ?? 0,
        routeAverageCrowding: Number(summary.avgCrowding),
      },
      querySignals: {
        preferredHour: travelCandidates.preferredHour,
        mentionedStops: travelCandidates.mentionedStopNames,
      },
      routeOptions: travelCandidates.routeOptions,
      fallbackRoute: travelCandidates.fallbackRoute,
    };
  }, [dataset, selectedDate, selectedHour, selectedRoute, selectedStop, summary, timeline, travelCandidates, travelPrompt]);

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

  async function runTravelRecommendation() {
    if (!llmPayload) {
      return;
    }

    setLlmLoadingAction(LLM_ACTION);
    setLlmError('');

    try {
      const response = await fetch('/api/llm-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: LLM_ACTION,
          context: llmPayload,
        }),
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || '맞춤 추천 요청에 실패했습니다.');
      }

      setLlmResponse(json);
    } catch (error) {
      setLlmError(error.message);
    } finally {
      setLlmLoadingAction('');
    }
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
          <p className="eyebrow">Predictive Bus Intelligence</p>
          <h1>서울 버스 혼잡 예측 대시보드</h1>
          <p className="subtitle">
            예측 혼잡도, 정류장별 승차량, 그리고 자유 입력 추천 에이전트를 함께 배치해
            특정 일정에 맞는 덜 붐비는 노선과 시간대를 빠르게 찾을 수 있게 구성했습니다.
          </p>
          <div className="value-points">
            <article className="value-card">
              <strong>노선별 예측</strong>
              <p>시간대별 평균 혼잡도를 기준으로 전체 흐름을 먼저 파악합니다.</p>
            </article>
            <article className="value-card">
              <strong>정류장별 비교</strong>
              <p>선택한 정류장의 승차량과 혼잡도를 바로 비교할 수 있습니다.</p>
            </article>
            <article className="value-card">
              <strong>맞춤 노선 추천</strong>
              <p>출발 정류장, 도착 정류장, 시간대를 입력하면 노선과 시간대를 자동으로 비교해 추천합니다.</p>
            </article>
          </div>
        </div>

        <div className="hero-metrics">
          <div className="stat-card">
            <span>선택 노선 평균 혼잡도</span>
            <strong>{summary.avgCrowding}%</strong>
            <small>{selectedSnapshot.label}</small>
          </div>
          <div className="stat-card accent">
            <span>선택 시간 최고 혼잡 정류장</span>
            <strong>{summary.peakStop.localStopName}</strong>
            <small>{formatPercent(summary.peakStop.crowding)}</small>
          </div>
          <div className="stat-card dark">
            <span>예측 모델</span>
            <strong>{dataset.model.name}</strong>
            <small>{dataset.model.description}</small>
          </div>
        </div>
      </header>

      <section className="info-strip">
        <article className="definition-panel glass">
          <p className="section-title">혼잡도 기준</p>
          <h2>혼잡도는 승차 인원을 버스 정원 45명 기준 비율로 환산합니다.</h2>
          <p>
            <strong>혼잡도(%) = (승차 인원 / 45) x 100</strong>
          </p>
          <p className="definition-note">100%는 정원과 같고, 100%를 넘으면 정원 초과 상태입니다.</p>
        </article>

        <article className="definition-panel glass">
          <p className="section-title">현재 설정</p>
          <ul className="guide-list">
            <li>날짜 선택 메뉴에서 실측 데이터와 예측 데이터를 함께 비교할 수 있습니다.</li>
            <li>학습 데이터 범위는 {dataset.actualDates[0]}부터 {dataset.latestActualDate}까지입니다.</li>
            <li>누락된 실제 날짜는 {dataset.missingActualDates.join(', ')}입니다.</li>
            <li>전 기간 혼잡도가 0으로만 기록된 노선은 자동 제외됩니다.</li>
            <li>OpenAI API를 사용할 수 없으면 규칙 기반 추천으로 자동 전환됩니다.</li>
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
                  <strong>{formatPercent(stop.crowding)}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="legend-block">
            <p className="section-title">현재 해석</p>
            <div className="legend-row"><i className="legend-dot cool" /> {selectedSnapshot.type === 'actual' ? '실측 데이터 기준 표시' : '예측 데이터 기준 표시'}</div>
            <div className="legend-row"><i className="legend-dot mild" /> 현재 단계: {crowdingLevelLabel(summary.peakStop.crowding)}</div>
            <div className="legend-row"><i className="legend-dot warm" /> 학습 데이터 {dataset.model.trainingDateCount}일</div>
            <div className="legend-row"><i className="legend-dot hot" /> 예측 범위 {dataset.model.predictionHorizonDays}일</div>
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
                <h3>정류장 위치와 시간대별 혼잡도를 한 화면에서 확인</h3>
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
                            승차 인원: ${object.passengers}명<br/>
                            혼잡도: ${object.crowding}%<br/>
                            단계: ${crowdingLevelLabel(object.crowding)}
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
                <span>Y축: 혼잡도 / X축: 시간대</span>
              </div>
              <p className="chart-description">
                선택한 노선 전체 정류장의 시간대별 평균 혼잡도를 보여줍니다.
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
                    <XAxis dataKey="hour" tick={{ fill: '#5f6770', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#5f6770', fontSize: 12 }} />
                    <Tooltip content={<CustomTooltip title="노선 평균 혼잡도" unit="%" />} />
                    <Area type="monotone" dataKey="crowding" name="혼잡도" stroke="#0b6e4f" fill="url(#routeGradient)" strokeWidth={3} />
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
                <span>Y축: 승차 인원 / X축: 시간대</span>
              </div>
              <p className="chart-description">
                선택한 정류장의 시간대별 승차 인원 변화를 보여줍니다.
              </p>
              <div className="chart-box">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={summary.stopSeries} margin={{ top: 12, right: 20, left: 8, bottom: 18 }}>
                    <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                    <XAxis dataKey="hour" tick={{ fill: '#5f6770', fontSize: 12 }} />
                    <YAxis tick={{ fill: '#5f6770', fontSize: 12 }} />
                    <Tooltip content={<CustomTooltip title="정류장 승차 인원" unit="명" />} />
                    <Line type="monotone" dataKey="passengers" name="승차 인원" stroke="#d94841" strokeWidth={3} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {selectedStop ? (
                <p className="stop-caption">
                  {`${selectedSnapshot.label} ${selectedHour} 기준 ${selectedStop.localStopName} 정류장의 승차 인원은 ${selectedStop.passengers}명이고 혼잡도는 ${selectedStop.crowding}%입니다.`}
                </p>
              ) : null}
            </article>
          </section>
        </section>

        <aside className="agent-rail">
          <section className="llm-panel glass">
            <div className="panel-head">
              <div>
                <p className="section-title">LLM Agent</p>
                <h3>출발/도착 정류장과 시간대를 입력하면 덜 붐비는 시간과 노선을 추천합니다.</h3>
              </div>
              <span>{dataset.model.name}</span>
            </div>

            <p className="chart-description">
              오른쪽 패널에서 출발지, 도착지, 시간대를 입력하고, 데이터에 맞는 노선과 시간대를 추천받을 수 있습니다.
            </p>

            <div className="prompt-card">
              <label>출발 정류장</label>
              <input
                type="text"
                className="prompt-input-single"
                value={departureStop}
                onChange={(event) => setDepartureStop(event.target.value)}
                placeholder="예: 창경궁"
              />
              <label>도착 정류장</label>
              <input
                type="text"
                className="prompt-input-single"
                value={destinationStop}
                onChange={(event) => setDestinationStop(event.target.value)}
                placeholder="예: 광장시장"
              />
              <label>시간대 (시)</label>
              <input
                type="number"
                className="prompt-input-single"
                value={travelTime}
                onChange={(event) => setTravelTime(event.target.value)}
                placeholder="예: 14"
                min="0"
                max="23"
              />
              <button
                type="button"
                className="action-button primary-action"
                onClick={runTravelRecommendation}
                disabled={!travelPrompt || llmLoadingAction === LLM_ACTION}
              >
                {llmLoadingAction === LLM_ACTION ? '추천 계산 중...' : '맞춤 추천 받기'}
              </button>
            </div>

            <div className="candidate-strip">
              <article className="candidate-card">
                <span>감지된 정류장</span>
                <strong>{travelCandidates?.mentionedStopNames.join(', ') || '아직 감지되지 않음'}</strong>
              </article>
              <article className="candidate-card">
                <span>희망 시간</span>
                <strong>{travelCandidates?.preferredHour ? `${travelCandidates.preferredHour.hour}시대` : '문장에서 찾지 못함'}</strong>
              </article>
              <article className="candidate-card">
                <span>후보 노선 수</span>
                <strong>{travelCandidates?.candidateCount ?? 0}개</strong>
              </article>
            </div>

            {travelCandidates?.routeOptions?.length ? (
              <div className="option-preview">
                {travelCandidates.routeOptions.slice(0, 3).map((option) => (
                  <article key={`${option.routeName}-${option.hour}`} className="option-card">
                    <div className="option-head">
                      <strong>{option.routeName}번</strong>
                      <span>{option.hour}</span>
                    </div>
                    <p>{`${option.originStopName} -> ${option.destinationStopName}`}</p>
                    <small>{`출발 혼잡 ${formatPercent(option.originCrowding)} / 노선 평균 ${formatPercent(option.routeCrowding)}`}</small>
                  </article>
                ))}
              </div>
            ) : (
              <div className="llm-placeholder compact">
                같은 노선에 포함된 출발지와 도착지를 찾으면 후보를 자동으로 비교합니다.
              </div>
            )}

            {llmError ? <div className="llm-error">{llmError}</div> : null}

            {llmResponse ? (
              <div className="llm-result">
                <div className="llm-summary">
                  <p className="section-title">{llmResponse.modeLabel}</p>
                  {llmResponse.fallback ? <small>규칙 기반 fallback 응답</small> : null}
                  <h4>{llmResponse.headline}</h4>
                  <p>{llmResponse.summary}</p>
                </div>

                <div className="llm-metrics">
                  {llmResponse.metrics.map((metric) => (
                    <article key={metric.label} className="llm-metric-card">
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                    </article>
                  ))}
                </div>

                <div className="llm-columns">
                  <article className="llm-list-card">
                    <h4>추천 근거</h4>
                    <ul>
                      {llmResponse.bullets.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </article>
                  <article className="llm-list-card">
                    <h4>권장 이동</h4>
                    <p>{llmResponse.recommendation}</p>
                    <small>{llmResponse.caution}</small>
                  </article>
                </div>
              </div>
            ) : null}
          </section>
        </aside>
      </main>
    </div>
  );
}

export default App;
