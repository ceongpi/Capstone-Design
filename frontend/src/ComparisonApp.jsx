import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import './index.css';

const DATA_URL = `${import.meta.env.BASE_URL}data/prediction_vs_actual.json`;
const EMPTY_ARRAY = [];

function formatPercent(value) {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

function formatSigned(value) {
  const number = Number(value ?? 0);
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function getBiasTone(value) {
  if (value > 3) return 'high';
  if (value < -3) return 'low';
  return 'balanced';
}

function getErrorTier(mae) {
  if (mae >= 8) return 'high';
  if (mae >= 4) return 'mid';
  return 'low';
}

function summarizeErrorLevel(mae) {
  if (mae >= 8) return '오차가 큰 편';
  if (mae >= 4) return '오차가 중간 수준';
  return '오차가 비교적 안정적';
}

function getRouteBadges(route, summary) {
  if (!route) {
    return EMPTY_ARRAY;
  }

  const badges = [];
  const weekdayMae = route.periodMetrics?.weekday?.mae ?? 0;
  const weekendMae = route.periodMetrics?.weekend?.mae ?? 0;
  const daytimeMae = route.periodMetrics?.daytime?.mae ?? route.metrics.mae;

  if (summary?.worstRoute?.routeName === route.routeName) {
    badges.push({ label: '최대 오차', tone: 'danger' });
  }
  if (daytimeMae - route.metrics.mae >= 0.8) {
    badges.push({ label: '주간 집중', tone: 'amber' });
  }
  if (weekendMae - weekdayMae >= 1) {
    badges.push({ label: '주말 민감', tone: 'blue' });
  }
  if (route.metrics.mae < 3 && daytimeMae >= 2.5) {
    badges.push({ label: '숨은 주간 편차', tone: 'green' });
  }

  return badges;
}

function buildRouteInterpretation(route, selectedDate, peakHour) {
  if (!route) {
    return EMPTY_ARRAY;
  }

  const lines = [];
  const { metrics, periodMetrics } = route;
  const weekdayMae = periodMetrics?.weekday?.mae ?? 0;
  const weekendMae = periodMetrics?.weekend?.mae ?? 0;
  const daytimeMae = periodMetrics?.daytime?.mae ?? metrics.mae;
  const stopSummary = selectedDate?.topStops?.slice(0, 3) ?? [];

  lines.push(
    `${route.routeName}은 전체 평균 MAE가 ${formatPercent(metrics.mae)}로 ${summarizeErrorLevel(metrics.mae)}입니다.`,
  );

  if (daytimeMae - metrics.mae >= 0.8) {
    lines.push(
      `하루 전체보다 08~21시 오차가 더 큽니다. 전체 MAE는 ${formatPercent(metrics.mae)}지만 주간 MAE는 ${formatPercent(daytimeMae)}입니다.`,
    );
  } else {
    lines.push(
      `주간 시간대 오차가 전체 평균과 크게 다르지 않습니다. 08~21시 MAE는 ${formatPercent(daytimeMae)}입니다.`,
    );
  }

  if (Math.abs(weekendMae - weekdayMae) >= 1) {
    const dominant = weekendMae > weekdayMae ? '주말' : '평일';
    lines.push(
      `${dominant} 패턴 오차가 더 큽니다. 평일 MAE ${formatPercent(weekdayMae)}, 주말 MAE ${formatPercent(weekendMae)}입니다.`,
    );
  } else {
    lines.push(
      `평일과 주말 오차 차이는 크지 않습니다. 평일 MAE ${formatPercent(weekdayMae)}, 주말 MAE ${formatPercent(weekendMae)}입니다.`,
    );
  }

  if (peakHour) {
    const direction =
      peakHour.bias > 1 ? '실측보다 높게 예측했습니다' : peakHour.bias < -1 ? '실측보다 낮게 예측했습니다' : '실측과 비슷한 수준입니다';
    lines.push(
      `가장 흔들리는 시간대는 ${peakHour.hour}이며, 이때 MAE는 ${formatPercent(peakHour.mae)}이고 ${direction}.`,
    );
  }

  if (stopSummary.length) {
    lines.push(
      `선택 날짜 기준 오차가 큰 정류장은 ${stopSummary.map((stop) => `${stop.stopName}(${formatPercent(stop.mae)})`).join(', ')}입니다.`,
    );
  }

  return lines;
}

function buildImprovementRecommendations(route, selectedDate, peakHour) {
  if (!route) {
    return EMPTY_ARRAY;
  }

  const recommendations = [];
  const { metrics, periodMetrics } = route;
  const weekdayMae = periodMetrics?.weekday?.mae ?? 0;
  const weekendMae = periodMetrics?.weekend?.mae ?? 0;
  const daytimeMae = periodMetrics?.daytime?.mae ?? metrics.mae;

  if (daytimeMae - metrics.mae >= 0.8) {
    recommendations.push(
      '시간대 특성 강화: agent.md 기준대로 `hour`, `peak_hour` 변수를 더 강하게 반영해 낮 시간 피크를 별도로 학습하는 것이 좋습니다.',
    );
  }

  if (Math.abs(weekendMae - weekdayMae) >= 1) {
    recommendations.push(
      '요일 체계 분리: `day_of_week`, `weekend` 기준으로 평일/주말 모델 가중치를 분리하거나, 같은 요일 표본 비중을 더 키우는 편이 낫습니다.',
    );
  }

  if (peakHour && Math.abs(peakHour.bias) >= 2) {
    recommendations.push(
      `피크 시간 보정: ${peakHour.hour}에 ${formatSigned(peakHour.bias)} 편향이 있으므로, 해당 시간대에는 최근값 기반 보정보다 같은 시간대 히스토리 비중을 높이는 것이 유효합니다.`,
    );
  }

  if ((selectedDate?.topStops?.[0]?.mae ?? 0) >= 4) {
    recommendations.push(
      '정류장 단위 보정: 오차 상위 정류장을 별도 군집으로 묶어 정류장 ID, 노선 ID, 상하행/구간 특성을 피처로 추가하면 정류장별 편차를 줄일 수 있습니다.',
    );
  }

  recommendations.push(
    '외부 변수 확장: agent.md에 적어둔 유동인구·날씨 데이터를 붙이면 비정상적인 수요 변동을 더 잘 따라갈 수 있습니다.',
  );
  recommendations.push(
    '모델 고도화: 현재 하이브리드 베이스라인 위에 RandomForest 또는 XGBoost 회귀 모델을 얹어 시간·요일·정류장 피처를 함께 학습하는 방식이 다음 단계로 적절합니다.',
  );

  return recommendations.slice(0, 5);
}

function TooltipCard({ active, payload, label, title }) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <strong>{title}</strong>
      <div>{label}</div>
      {payload.map((item) => (
        <div key={item.dataKey}>
          {`${item.name}: ${formatPercent(item.value)}`}
        </div>
      ))}
    </div>
  );
}

function ComparisonApp() {
  const [dataset, setDataset] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedRouteName, setSelectedRouteName] = useState('');
  const [selectedDate, setSelectedDate] = useState('');

  useEffect(() => {
    let active = true;

    fetch(DATA_URL)
      .then((response) => {
        if (!response.ok) {
          throw new Error('비교 데이터를 불러오지 못했습니다.');
        }
        return response.json();
      })
      .then((json) => {
        if (!active) {
          return;
        }

        setDataset(json);
        setSelectedRouteName(json.routes[0]?.routeName ?? '');
        setSelectedDate(json.comparisonDates[0] ?? '');
        setErrorMessage('');
      })
      .catch((error) => {
        if (!active) {
          return;
        }
        setErrorMessage(error.message);
      });

    return () => {
      active = false;
    };
  }, []);

  const routes = dataset?.routes ?? EMPTY_ARRAY;
  const dates = dataset?.dates ?? EMPTY_ARRAY;

  const selectedRoute = useMemo(
    () => routes.find((route) => route.routeName === selectedRouteName) ?? null,
    [routes, selectedRouteName],
  );

  const selectedRouteDate = useMemo(
    () => selectedRoute?.daily.find((day) => day.date === selectedDate) ?? selectedRoute?.daily[0] ?? null,
    [selectedDate, selectedRoute],
  );

  const topRoutes = useMemo(
    () =>
      routes.slice(0, 10).map((route) => ({
        routeName: route.routeName,
        mae: route.metrics.mae,
        bias: route.metrics.bias,
      })),
    [routes],
  );

  const routeTable = useMemo(
    () =>
      routes.map((route, index) => ({
        rank: index + 1,
        routeName: route.routeName,
        mae: route.metrics.mae,
        daytimeMae: route.periodMetrics?.daytime?.mae ?? route.metrics.mae,
        weekdayMae: route.periodMetrics?.weekday?.mae ?? 0,
        weekendMae: route.periodMetrics?.weekend?.mae ?? 0,
        bias: route.metrics.bias,
        peakHour: route.peakHour?.hour ?? '-',
        badges: getRouteBadges(route, dataset?.summary),
      })),
    [dataset?.summary, routes],
  );

  const topStops = selectedRouteDate?.topStops ?? EMPTY_ARRAY;
  const selectedBiasTone = getBiasTone(selectedRoute?.metrics.bias ?? 0);
  const selectedPeakHour = selectedRouteDate?.peakHour ?? selectedRoute?.peakHour ?? null;
  const selectedRouteBadges = useMemo(
    () => getRouteBadges(selectedRoute, dataset?.summary),
    [dataset?.summary, selectedRoute],
  );
  const routeInterpretation = useMemo(
    () => buildRouteInterpretation(selectedRoute, selectedRouteDate, selectedPeakHour),
    [selectedPeakHour, selectedRoute, selectedRouteDate],
  );
  const improvementRecommendations = useMemo(
    () => buildImprovementRecommendations(selectedRoute, selectedRouteDate, selectedPeakHour),
    [selectedPeakHour, selectedRoute, selectedRouteDate],
  );

  if (errorMessage) {
    return <div className="loading">{errorMessage}</div>;
  }

  if (!dataset || !selectedRoute || !selectedRouteDate) {
    return <div className="loading">비교 데이터를 불러오는 중입니다.</div>;
  }

  return (
    <div className="comparison-shell">
      <header className="comparison-hero glass">
        <div className="comparison-copy">
          <p className="eyebrow">Prediction Audit</p>
          <h1>4.23~4.29 예측값 vs 실측값 비교</h1>
          <p className="subtitle">
            기존 예측 결과를 실제 수집 데이터와 같은 기준으로 다시 계산한 비교 화면입니다.
            노선 평균뿐 아니라 시간대와 정류장 단위 편차, 그리고 오차 해석과 개선 방향까지 함께 확인할 수 있습니다.
          </p>
          <div className="comparison-note-row">
            <article className="comparison-note-card">
              <span>예측 기준일</span>
              <strong>{dataset.predictionSourceLatestActualDate}</strong>
              <small>해당 날짜까지의 실측 데이터만 사용해 예측을 생성했습니다.</small>
            </article>
            <article className="comparison-note-card">
              <span>비교 범위</span>
              <strong>{dataset.summary.routeCount}개 노선</strong>
              <small>{dataset.summary.dateCount}일 x 24시간 평균 혼잡도 집계</small>
            </article>
          </div>
        </div>

        <div className="comparison-stats">
          <article className="stat-card">
            <span>전체 평균 MAE</span>
            <strong>{formatPercent(dataset.summary.mae)}</strong>
            <small>예측값과 실측값의 평균 차이</small>
          </article>
          <article className="stat-card accent">
            <span>과대/과소 편향</span>
            <strong>{formatSigned(dataset.summary.bias)}</strong>
            <small>{dataset.summary.bias >= 0 ? '전체적으로 높게 예측한 경향' : '전체적으로 낮게 예측한 경향'}</small>
          </article>
          <article className="stat-card dark">
            <span>최대 오차 노선</span>
            <strong>{dataset.summary.worstRoute?.routeName ?? '-'}</strong>
            <small>{dataset.summary.worstRoute ? `MAE ${formatPercent(dataset.summary.worstRoute.mae)}` : '집계 없음'}</small>
          </article>
        </div>
      </header>

      <section className="comparison-strip">
        <article className="comparison-definition glass">
          <p className="section-title">비교 기준</p>
          <h2>실측 재차인원과 예측 재차인원을 모두 정원 45명 기준 혼잡도로 환산했습니다.</h2>
          <p><strong>혼잡도(%) = (재차인원 / 45) x 100</strong></p>
          <p>노선별 오차는 정류장 x 시간대 단위 차이를 평균한 값입니다.</p>
        </article>

        <article className={`comparison-bias-card glass tone-${selectedBiasTone}`}>
          <p className="section-title">선택 노선 해석</p>
          <h2>{selectedRoute.routeName}</h2>
          <div className="route-badge-row">
            {selectedRouteBadges.map((badge) => (
              <span key={badge.label} className={`route-badge tone-${badge.tone}`}>{badge.label}</span>
            ))}
          </div>
          <p>{`평균 MAE ${formatPercent(selectedRoute.metrics.mae)}, 편향 ${formatSigned(selectedRoute.metrics.bias)}`}</p>
          <p>
            {selectedRoute.metrics.bias > 3
              ? '이 노선은 예측값이 실측보다 전반적으로 높게 형성되는 구간이 많습니다.'
              : selectedRoute.metrics.bias < -3
                ? '이 노선은 예측값이 실측보다 전반적으로 낮게 형성되는 구간이 많습니다.'
                : '이 노선은 과대 예측과 과소 예측이 비교적 균형에 가깝습니다.'}
          </p>
        </article>
      </section>

      <main className="comparison-grid">
        <aside className="comparison-side glass">
          <section>
            <label htmlFor="comparisonRoute">노선 선택</label>
            <select
              id="comparisonRoute"
              value={selectedRouteName}
              onChange={(event) => setSelectedRouteName(event.target.value)}
            >
              {routes.map((route) => (
                <option key={route.routeName} value={route.routeName}>
                  {`${route.routeName} · MAE ${formatPercent(route.metrics.mae)}`}
                </option>
              ))}
            </select>
          </section>

          <section>
            <label htmlFor="comparisonDate">날짜 선택</label>
            <select
              id="comparisonDate"
              value={selectedRouteDate.date}
              onChange={(event) => setSelectedDate(event.target.value)}
            >
              {selectedRoute.daily.map((day) => (
                <option key={day.date} value={day.date}>
                  {`${day.label} · MAE ${formatPercent(day.mae)}`}
                </option>
              ))}
            </select>
          </section>

          <section>
            <p className="section-title">선택 날짜 요약</p>
            <div className="comparison-mini-stats comparison-mini-stats-wide">
              <article className="candidate-card">
                <span>예측 평균</span>
                <strong>{formatPercent(selectedRouteDate.predictedAvg)}</strong>
              </article>
              <article className="candidate-card">
                <span>실측 평균</span>
                <strong>{formatPercent(selectedRouteDate.actualAvg)}</strong>
              </article>
              <article className="candidate-card">
                <span>하루 MAE</span>
                <strong>{formatPercent(selectedRouteDate.mae)}</strong>
              </article>
              <article className="candidate-card">
                <span>08~21시 MAE</span>
                <strong>{formatPercent(selectedRouteDate.daytimeMae)}</strong>
              </article>
            </div>
          </section>

          <section>
            <p className="section-title">노선 패턴</p>
            <div className="comparison-mini-stats">
              <article className="candidate-card">
                <span>전체 MAE</span>
                <strong>{formatPercent(selectedRoute.metrics.mae)}</strong>
              </article>
              <article className="candidate-card">
                <span>08~21시 MAE</span>
                <strong>{formatPercent(selectedRoute.periodMetrics?.daytime?.mae)}</strong>
              </article>
              <article className="candidate-card">
                <span>평일 / 주말</span>
                <strong>{`${formatPercent(selectedRoute.periodMetrics?.weekday?.mae)} / ${formatPercent(selectedRoute.periodMetrics?.weekend?.mae)}`}</strong>
              </article>
            </div>
          </section>

          <section>
            <p className="section-title">피크 시간대</p>
            <div className="comparison-mini-stats">
              <article className="candidate-card">
                <span>시간대</span>
                <strong>{selectedPeakHour?.hour ?? '-'}</strong>
              </article>
              <article className="candidate-card">
                <span>피크 MAE</span>
                <strong>{formatPercent(selectedPeakHour?.mae)}</strong>
              </article>
              <article className="candidate-card">
                <span>Bias</span>
                <strong>{formatSigned(selectedPeakHour?.bias)}</strong>
              </article>
            </div>
          </section>

          <section>
            <p className="section-title">오차 큰 정류장</p>
            <div className="stop-list comparison-stop-list">
              {topStops.map((stop) => (
                <div key={`${selectedRouteDate.date}-${stop.sequence}`} className="stop-chip comparison-stop-chip">
                  <span>{`${stop.sequence}. ${stop.stopName}`}</span>
                  <strong>{formatPercent(stop.mae)}</strong>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <section className="comparison-content">
          <article className="chart-panel glass">
            <div className="panel-head">
              <div>
                <p className="section-title">Route Reading</p>
                <h3>{`${selectedRoute.routeName} 오차 해석`}</h3>
              </div>
              <span>{selectedRouteDate.label}</span>
            </div>
            <div className="insight-list">
              {routeInterpretation.map((line) => (
                <article key={line} className="insight-card">
                  <p>{line}</p>
                </article>
              ))}
            </div>
          </article>

          <article className="chart-panel glass emphasis">
            <div className="panel-head">
              <div>
                <p className="section-title">Recommendations</p>
                <h3>오차 줄이기 추천</h3>
              </div>
              <span>agent.md 반영</span>
            </div>
            <div className="recommendation-list">
              {improvementRecommendations.map((item) => (
                <article key={item} className="recommendation-card">
                  <p>{item}</p>
                </article>
              ))}
            </div>
          </article>

          <article className="chart-panel glass">
            <div className="panel-head">
              <div>
                <p className="section-title">Date Trend</p>
                <h3>전체 노선 날짜별 예측 평균과 실측 평균</h3>
              </div>
              <span>4.23 ~ 4.29</span>
            </div>
            <div className="chart-box comparison-chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={dates} margin={{ top: 12, right: 20, left: 8, bottom: 12 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                  <XAxis dataKey="label" tick={{ fill: '#5f6770', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#5f6770', fontSize: 12 }} />
                  <Tooltip content={<TooltipCard title="날짜별 평균 혼잡도" />} />
                  <Legend />
                  <Line type="monotone" dataKey="predictedAvg" name="예측 평균" stroke="#0b6e4f" strokeWidth={3} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="actualAvg" name="실측 평균" stroke="#d94841" strokeWidth={3} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article className="chart-panel glass emphasis">
            <div className="panel-head">
              <div>
                <p className="section-title">Hourly Detail</p>
                <h3>{`${selectedRoute.routeName} ${selectedRouteDate.label}`}</h3>
              </div>
              <span>{`노선 평균 MAE ${formatPercent(selectedRoute.metrics.mae)}`}</span>
            </div>
            <div className="chart-box comparison-chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={selectedRouteDate.hourly} margin={{ top: 12, right: 20, left: 8, bottom: 12 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                  <XAxis dataKey="hour" tick={{ fill: '#5f6770', fontSize: 12 }} />
                  <YAxis tick={{ fill: '#5f6770', fontSize: 12 }} />
                  <Tooltip content={<TooltipCard title="시간대별 노선 평균 혼잡도" />} />
                  <Legend />
                  <Line type="monotone" dataKey="predictedAvg" name="예측 평균" stroke="#153b30" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="actualAvg" name="실측 평균" stroke="#d94841" strokeWidth={3} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article className="chart-panel glass">
            <div className="panel-head">
              <div>
                <p className="section-title">Route Ranking</p>
                <h3>평균 MAE가 큰 노선</h3>
              </div>
              <span>상위 10개</span>
            </div>
            <div className="chart-box comparison-chart-box tall">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topRoutes} layout="vertical" margin={{ top: 10, right: 18, left: 12, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                  <XAxis type="number" tick={{ fill: '#5f6770', fontSize: 12 }} />
                  <YAxis dataKey="routeName" type="category" width={56} tick={{ fill: '#5f6770', fontSize: 12 }} />
                  <Tooltip content={<TooltipCard title="노선별 평균 MAE" />} />
                  <Bar dataKey="mae" name="MAE" radius={[0, 10, 10, 0]}>
                    {topRoutes.map((route) => (
                      <Cell key={route.routeName} fill={route.routeName === selectedRoute.routeName ? '#0b6e4f' : '#d89e74'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </article>

          <article className="chart-panel glass">
            <div className="panel-head">
              <div>
                <p className="section-title">All Routes</p>
                <h3>각 노선 오차 요약</h3>
              </div>
              <span>{`${routeTable.length}개 노선`}</span>
            </div>
            <div className="route-table-wrap">
              <table className="route-table">
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>노선</th>
                    <th>전체 MAE</th>
                    <th>08~21시 MAE</th>
                    <th>평일 MAE</th>
                    <th>주말 MAE</th>
                    <th>Bias</th>
                    <th>피크 시간</th>
                  </tr>
                </thead>
                <tbody>
                  {routeTable.map((route) => (
                    <tr key={route.routeName} className={route.routeName === selectedRoute.routeName ? 'active' : ''}>
                      <td>{route.rank}</td>
                      <td>
                        <div className="route-name-cell">
                          <span>{route.routeName}</span>
                          <div className="route-badge-row route-badge-row-inline">
                            {route.badges.map((badge) => (
                              <span key={`${route.routeName}-${badge.label}`} className={`route-badge tone-${badge.tone}`}>{badge.label}</span>
                            ))}
                          </div>
                        </div>
                      </td>
                      <td><span className={`metric-pill tier-${getErrorTier(route.mae)}`}>{formatPercent(route.mae)}</span></td>
                      <td>{formatPercent(route.daytimeMae)}</td>
                      <td>{formatPercent(route.weekdayMae)}</td>
                      <td>{formatPercent(route.weekendMae)}</td>
                      <td>{formatSigned(route.bias)}</td>
                      <td>{route.peakHour}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="chart-panel glass">
            <div className="panel-head">
              <div>
                <p className="section-title">Stop Ranking</p>
                <h3>{`${selectedRoute.routeName}의 오차가 큰 정류장`}</h3>
              </div>
              <span>{selectedRouteDate.label}</span>
            </div>
            <div className="chart-box comparison-chart-box tall">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topStops.slice(0, 10)} layout="vertical" margin={{ top: 10, right: 18, left: 12, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#d8d0c4" />
                  <XAxis type="number" tick={{ fill: '#5f6770', fontSize: 12 }} />
                  <YAxis dataKey="stopName" type="category" width={140} tick={{ fill: '#5f6770', fontSize: 11 }} />
                  <Tooltip content={<TooltipCard title="정류장별 평균 MAE" />} />
                  <Bar dataKey="mae" name="MAE" fill="#d94841" radius={[0, 10, 10, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </article>
        </section>
      </main>
    </div>
  );
}

export default ComparisonApp;
