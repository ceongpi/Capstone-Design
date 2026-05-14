const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const FRONTEND_DATA_DIR = path.join(ROOT, 'frontend', 'public', 'data');
const PREDICTION_DATA_FILE = path.join(FRONTEND_DATA_DIR, 'selected_routes.json');
const OUTPUT_FILE = 'prediction_vs_actual.json';
const BUS_CAPACITY = 45;
const TARGET_DATES = [
  '2026-04-23',
  '2026-04-24',
  '2026-04-25',
  '2026-04-26',
  '2026-04-27',
  '2026-04-28',
  '2026-04-29',
];
const CSV_FILE_PATTERN = /_(\d{8})\.csv$/;
const KOREAN_TIMEZONE = 'Asia/Seoul';
const DAYTIME_START_HOUR = 8;
const DAYTIME_END_HOUR = 21;
const WEEKEND_DAY_INDEXES = new Set([0, 6]);
const ROUTE_NAME_ALIASES = {
  '110A': ['110A고려대'],
  '110B': ['110B국민대'],
  '2115A': ['2115'],
  '2115B': ['2115'],
};

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function normalizeStopName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/\(.*?\)/g, '')
    .replace(/[.\-,/]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function round2(value) {
  return Number(value.toFixed(2));
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mean(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return 0;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function rmse(errors) {
  const filtered = errors.filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return 0;
  }
  return Math.sqrt(mean(filtered.map((error) => error ** 2)));
}

function formatDateLabel(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: KOREAN_TIMEZONE,
  }).format(date);
}

function getHourNumber(hourLabel) {
  const match = String(hourLabel || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function isDaytimeHour(hourLabel) {
  const hour = getHourNumber(hourLabel);
  return hour != null && hour >= DAYTIME_START_HOUR && hour <= DAYTIME_END_HOUR;
}

function passengersToCrowding(passengers) {
  return round2((passengers / BUS_CAPACITY) * 100);
}

function parseDateFromFilename(filename) {
  const match = filename.match(CSV_FILE_PATTERN);
  if (!match) {
    return null;
  }

  const value = match[1];
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function decodeEucKr(buffer) {
  return new TextDecoder('euc-kr').decode(buffer);
}

function loadActualCsv(date) {
  const filename = fs.readdirSync(ROOT).find((entry) => parseDateFromFilename(entry) === date);
  if (!filename) {
    return null;
  }

  const text = decodeEucKr(fs.readFileSync(path.join(ROOT, filename)));
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]).filter((item) => item !== '');
  const routeKey = header[0];
  const sequenceKey = header[2];
  const stopNameKey = header[3];
  const hourKeys = header.slice(4, 28);
  const byRoute = {};

  lines.slice(1).forEach((line) => {
    if (!line.trim()) {
      return;
    }

    const columns = parseCsvLine(line);
    const row = {};
    header.forEach((key, index) => {
      row[key] = columns[index] ?? '';
    });

    const routeName = row[routeKey];
    if (!routeName) {
      return;
    }

    (byRoute[routeName] ||= []).push({
      routeName,
      sequence: toNumber(row[sequenceKey]),
      stopName: row[stopNameKey],
      stopNameNormalized: normalizeStopName(row[stopNameKey]),
      passengersByHour: hourKeys.map((hourKey) => toNumber(row[hourKey])),
    });
  });

  Object.values(byRoute).forEach((stops) => {
    stops.sort((left, right) => left.sequence - right.sequence);
  });

  return byRoute;
}

function resolveActualRoute(routeName, actualByRoute) {
  const candidates = [routeName, ...(ROUTE_NAME_ALIASES[routeName] || [])];
  for (const candidate of candidates) {
    if (actualByRoute[candidate]) {
      return actualByRoute[candidate];
    }
  }
  return null;
}

function alignStops(predictedRoute, actualStops) {
  const actualBySequence = new Map();
  const actualByName = new Map();

  actualStops.forEach((stop, index) => {
    actualBySequence.set(stop.sequence, stop);
    if (!actualByName.has(stop.stopNameNormalized)) {
      actualByName.set(stop.stopNameNormalized, []);
    }
    actualByName.get(stop.stopNameNormalized).push({ ...stop, _index: index });
  });

  return predictedRoute.stops.map((stop, index) => {
    const exact = actualStops.find(
      (candidate) =>
        candidate.sequence === stop.sequence && candidate.stopNameNormalized === stop.localStopNameNormalized,
    );
    const bySequence = actualBySequence.get(stop.sequence);
    const byName = actualByName.get(stop.localStopNameNormalized)?.[0] ?? null;
    const fallback = actualStops[index] ?? null;
    const matched = exact ?? bySequence ?? byName ?? fallback;

    if (!matched) {
      return null;
    }

    return {
      predictedStop: stop,
      actualStop: matched,
    };
  }).filter(Boolean);
}

function buildRouteDateMetrics(route, snapshot, alignedStops, hours) {
  const hourly = hours.map((hour, hourIndex) => {
    const predictedValues = [];
    const actualValues = [];
    const errors = [];

    alignedStops.forEach(({ predictedStop, actualStop }) => {
      const stopIndex = predictedStop.sequence - 1;
      const predictedPassengers = snapshot.stopPassengers[stopIndex]?.[hourIndex];
      const actualPassengers = actualStop.passengersByHour[hourIndex];

      if (!Number.isFinite(predictedPassengers) || !Number.isFinite(actualPassengers)) {
        return;
      }

      const predictedCrowding = passengersToCrowding(predictedPassengers);
      const actualCrowding = passengersToCrowding(actualPassengers);
      predictedValues.push(predictedCrowding);
      actualValues.push(actualCrowding);
      errors.push(predictedCrowding - actualCrowding);
    });

    const predictedAvg = round2(mean(predictedValues));
    const actualAvg = round2(mean(actualValues));
    const bias = round2(predictedAvg - actualAvg);

    return {
      hour,
      predictedAvg,
      actualAvg,
      mae: round2(mean(errors.map((error) => Math.abs(error)))),
      rmse: round2(rmse(errors)),
      bias,
    };
  });

  const stopMetrics = alignedStops.map(({ predictedStop, actualStop }) => {
    const stopIndex = predictedStop.sequence - 1;
    const pairs = hours.map((_, hourIndex) => {
      const predictedPassengers = snapshot.stopPassengers[stopIndex]?.[hourIndex];
      const actualPassengers = actualStop.passengersByHour[hourIndex];
      const predictedCrowding = passengersToCrowding(predictedPassengers);
      const actualCrowding = passengersToCrowding(actualPassengers);
      const error = round2(predictedCrowding - actualCrowding);

      return { predicted: predictedCrowding, actual: actualCrowding, error };
    });

    const errors = pairs.map((pair) => pair.error);
    const predictedValues = pairs.map((pair) => pair.predicted);
    const actualValues = pairs.map((pair) => pair.actual);

    return {
      sequence: predictedStop.sequence,
      stopName: predictedStop.localStopName,
      predictedAvg: round2(mean(predictedValues)),
      actualAvg: round2(mean(actualValues)),
      mae: round2(mean(errors.map((error) => Math.abs(error)))),
      rmse: round2(rmse(errors)),
      bias: round2(mean(errors)),
    };
  });

  const allErrors = [];
  alignedStops.forEach(({ predictedStop, actualStop }) => {
    const stopIndex = predictedStop.sequence - 1;
    hours.forEach((_, hourIndex) => {
      const predictedPassengers = snapshot.stopPassengers[stopIndex]?.[hourIndex];
      const actualPassengers = actualStop.passengersByHour[hourIndex];
      if (!Number.isFinite(predictedPassengers) || !Number.isFinite(actualPassengers)) {
        return;
      }

      const predictedCrowding = passengersToCrowding(predictedPassengers);
      const actualCrowding = passengersToCrowding(actualPassengers);
      allErrors.push(round2(predictedCrowding - actualCrowding));
    });
  });
  const predictedAverages = hourly.map((entry) => entry.predictedAvg);
  const actualAverages = hourly.map((entry) => entry.actualAvg);
  const daytimeHourly = hourly.filter((entry) => isDaytimeHour(entry.hour));
  const peakHour = [...hourly].sort((left, right) => right.mae - left.mae)[0] ?? null;

  return {
    date: snapshot.date,
    label: snapshot.label || formatDateLabel(snapshot.date),
    weekdayIndex: snapshot.weekdayIndex,
    predictedAvg: round2(mean(predictedAverages)),
    actualAvg: round2(mean(actualAverages)),
    mae: round2(mean(allErrors.map((error) => Math.abs(error)))),
    rmse: round2(rmse(allErrors)),
    bias: round2(mean(allErrors)),
    daytimeMae: round2(mean(daytimeHourly.map((entry) => entry.mae))),
    peakHour,
    hourly,
    topStops: [...stopMetrics].sort((left, right) => right.mae - left.mae).slice(0, 12),
    matchedStopCount: stopMetrics.length,
  };
}

function buildComparisonDataset() {
  const predictionDataset = JSON.parse(fs.readFileSync(PREDICTION_DATA_FILE, 'utf8'));
  const hours = predictionDataset.hours;
  const routes = [];
  const allDateMetrics = [];

  TARGET_DATES.forEach((date) => {
    const dailyActual = loadActualCsv(date);
    if (!dailyActual) {
      throw new Error(`${date} 실측 CSV를 찾을 수 없습니다.`);
    }

    predictionDataset.routes.forEach((route) => {
      const snapshot = route.snapshots.find((item) => item.date === date && item.type === 'predicted');
      if (!snapshot) {
        return;
      }

      const actualRoute = resolveActualRoute(route.routeName, dailyActual);
      if (!actualRoute?.length) {
        return;
      }

      const alignedStops = alignStops(route, actualRoute);
      if (!alignedStops.length) {
        return;
      }

      let routeEntry = routes.find((item) => item.routeName === route.routeName);
      if (!routeEntry) {
        routeEntry = {
          routeName: route.routeName,
          routeId: route.routeId,
          stopCount: route.stopCountLocal,
          matchedStopCount: 0,
          daily: [],
        };
        routes.push(routeEntry);
      }

      const dateMetrics = buildRouteDateMetrics(route, snapshot, alignedStops, hours);
      routeEntry.daily.push(dateMetrics);
      routeEntry.matchedStopCount = Math.max(routeEntry.matchedStopCount, dateMetrics.matchedStopCount);
      allDateMetrics.push({
        routeName: route.routeName,
        ...dateMetrics,
      });
    });
  });

  routes.forEach((route) => {
    route.daily.sort((left, right) => left.date.localeCompare(right.date));

    const hourly = hours.map((hour) => {
      const entries = route.daily.map((day) => day.hourly.find((item) => item.hour === hour)).filter(Boolean);
      const errors = entries.map((entry) => entry.bias);
      return {
        hour,
        predictedAvg: round2(mean(entries.map((entry) => entry.predictedAvg))),
        actualAvg: round2(mean(entries.map((entry) => entry.actualAvg))),
        mae: round2(mean(entries.map((entry) => entry.mae))),
        rmse: round2(mean(entries.map((entry) => entry.rmse))),
        bias: round2(mean(errors)),
      };
    });

    const stopMap = new Map();
    route.daily.forEach((day) => {
      day.topStops.forEach((stop) => {
        const current = stopMap.get(stop.sequence) ?? {
          sequence: stop.sequence,
          stopName: stop.stopName,
          predictedAvg: [],
          actualAvg: [],
          maes: [],
          rmses: [],
          biases: [],
        };

        current.predictedAvg.push(stop.predictedAvg);
        current.actualAvg.push(stop.actualAvg);
        current.maes.push(stop.mae);
        current.rmses.push(stop.rmse);
        current.biases.push(stop.bias);
        stopMap.set(stop.sequence, current);
      });
    });

    route.topStops = Array.from(stopMap.values()).map((stop) => ({
      sequence: stop.sequence,
      stopName: stop.stopName,
      predictedAvg: round2(mean(stop.predictedAvg)),
      actualAvg: round2(mean(stop.actualAvg)),
      mae: round2(mean(stop.maes)),
      rmse: round2(mean(stop.rmses)),
      bias: round2(mean(stop.biases)),
    })).sort((left, right) => right.mae - left.mae).slice(0, 20);

    const allErrors = route.daily.flatMap((day) =>
      day.hourly.map((entry) => entry.bias),
    );
    const daytimeHours = hourly.filter((entry) => isDaytimeHour(entry.hour));
    const peakHour = [...hourly].sort((left, right) => right.mae - left.mae)[0] ?? null;
    const weekdayDays = route.daily.filter((day) => !WEEKEND_DAY_INDEXES.has(day.weekdayIndex));
    const weekendDays = route.daily.filter((day) => WEEKEND_DAY_INDEXES.has(day.weekdayIndex));

    route.metrics = {
      predictedAvg: round2(mean(route.daily.map((day) => day.predictedAvg))),
      actualAvg: round2(mean(route.daily.map((day) => day.actualAvg))),
      mae: round2(mean(route.daily.map((day) => day.mae))),
      daytimeMae: round2(mean(route.daily.map((day) => day.daytimeMae))),
      rmse: round2(rmse(allErrors)),
      bias: round2(mean(allErrors)),
    };
    route.periodMetrics = {
      daytime: {
        hourRange: `${String(DAYTIME_START_HOUR).padStart(2, '0')}:00-${String(DAYTIME_END_HOUR).padStart(2, '0')}:59`,
        mae: round2(mean(daytimeHours.map((entry) => entry.mae))),
        bias: round2(mean(daytimeHours.map((entry) => entry.bias))),
      },
      weekday: {
        mae: round2(mean(weekdayDays.map((day) => day.mae))),
        bias: round2(mean(weekdayDays.map((day) => day.bias))),
      },
      weekend: {
        mae: round2(mean(weekendDays.map((day) => day.mae))),
        bias: round2(mean(weekendDays.map((day) => day.bias))),
      },
    };
    route.peakHour = peakHour;
    route.hourly = hourly;
  });

  routes.sort((left, right) => right.metrics.mae - left.metrics.mae);

  const dates = TARGET_DATES.map((date) => {
    const entries = allDateMetrics.filter((item) => item.date === date);
    const errors = entries.map((entry) => entry.bias);
    return {
      date,
      label: formatDateLabel(date),
      predictedAvg: round2(mean(entries.map((entry) => entry.predictedAvg))),
      actualAvg: round2(mean(entries.map((entry) => entry.actualAvg))),
      mae: round2(mean(entries.map((entry) => entry.mae))),
      rmse: round2(rmse(errors)),
      bias: round2(mean(errors)),
      matchedRouteCount: entries.length,
    };
  });

  const overallErrors = allDateMetrics.map((entry) => entry.bias);
  const bestRoute = [...routes].sort((left, right) => left.metrics.mae - right.metrics.mae)[0] ?? null;
  const worstRoute = routes[0] ?? null;

  return {
    generatedAt: new Date().toISOString(),
    predictionSourceLatestActualDate: predictionDataset.latestActualDate,
    comparisonDates: TARGET_DATES,
    hours,
    summary: {
      routeCount: routes.length,
      dateCount: TARGET_DATES.length,
      predictedAvg: round2(mean(allDateMetrics.map((entry) => entry.predictedAvg))),
      actualAvg: round2(mean(allDateMetrics.map((entry) => entry.actualAvg))),
      mae: round2(mean(allDateMetrics.map((entry) => entry.mae))),
      rmse: round2(rmse(overallErrors)),
      bias: round2(mean(overallErrors)),
      bestRoute: bestRoute
        ? { routeName: bestRoute.routeName, mae: bestRoute.metrics.mae }
        : null,
      worstRoute: worstRoute
        ? { routeName: worstRoute.routeName, mae: worstRoute.metrics.mae }
        : null,
    },
    dates,
    routes,
  };
}

function main() {
  const dataset = buildComparisonDataset();
  const json = JSON.stringify(dataset, null, 2);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(FRONTEND_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, OUTPUT_FILE), json, 'utf8');
  fs.writeFileSync(path.join(FRONTEND_DATA_DIR, OUTPUT_FILE), json, 'utf8');
  console.log(JSON.stringify(dataset.summary, null, 2));
}

main();
