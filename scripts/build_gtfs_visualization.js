const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const FRONTEND_DATA_DIR = path.join(ROOT, 'frontend', 'public', 'data');
const GTFS_DIR = path.join(ROOT, 'gtfs_raw', 'GTFS_Korea_2024');

const GTFS_FILES = {
  routes: path.join(GTFS_DIR, 'routes.txt'),
  trips: path.join(GTFS_DIR, 'trips.txt'),
  stopTimes: path.join(GTFS_DIR, 'stop_times.txt'),
  stops: path.join(GTFS_DIR, 'stops.txt'),
};

const BUS_CAPACITY = 45;
const PREDICTION_DAYS = 7;
const HOUR_COLUMNS = Array.from({ length: 24 }, (_, index) => `${String((index + 4) % 24).padStart(2, '0')}시`);
const CSV_FILE_PATTERN = /_(\d{8})\.csv$/;
const KOREAN_TIMEZONE = 'Asia/Seoul';
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function round2(value) {
  return Number(value.toFixed(2));
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

function addDays(dateString, offset) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function getMissingDates(dates) {
  if (!dates.length) {
    return [];
  }

  const knownDates = new Set(dates);
  const missingDates = [];
  let cursor = dates[0];
  const lastDate = dates[dates.length - 1];

  while (cursor <= lastDate) {
    if (!knownDates.has(cursor)) {
      missingDates.push(cursor);
    }
    cursor = addDays(cursor, 1);
  }

  return missingDates;
}

function getWeekdayIndex(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
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

function getCrowdingCsvFiles() {
  return fs
    .readdirSync(ROOT)
    .filter((filename) => CSV_FILE_PATTERN.test(filename))
    .sort((left, right) => left.localeCompare(right, 'ko'));
}

function decodeEucKr(buffer) {
  return new TextDecoder('euc-kr').decode(buffer);
}

function readDailyCrowding(filePath) {
  const text = decodeEucKr(fs.readFileSync(filePath));
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]).filter((item) => item !== '');
  const routeKey = header[0];
  const terminalKey = header[1];
  const sequenceKey = header[2];
  const stopNameKey = header[3];
  const hourKeys = header.slice(4, 4 + HOUR_COLUMNS.length);

  const rows = lines.slice(1).map((line) => {
    const columns = parseCsvLine(line);
    const row = {};
    header.forEach((key, index) => {
      row[key] = columns[index] ?? '';
    });
    return row;
  });

  const byRoute = {};

  for (const row of rows) {
    const routeName = row[routeKey];
    if (!routeName) {
      continue;
    }

    const passengersByHour = hourKeys.map((hourKey) => toNumber(row[hourKey]));
    (byRoute[routeName] ||= []).push({
      route: routeName,
      terminal: row[terminalKey],
      sequence: toNumber(row[sequenceKey]),
      stopName: row[stopNameKey],
      stopNameNormalized: normalizeStopName(row[stopNameKey]),
      passengersByHour,
    });
  }

  for (const routeName of Object.keys(byRoute)) {
    byRoute[routeName].sort((left, right) => left.sequence - right.sequence);
  }

  return byRoute;
}

function readAllCrowding() {
  const files = getCrowdingCsvFiles();
  if (!files.length) {
    throw new Error('혼잡도 CSV 파일을 찾을 수 없습니다.');
  }

  const byDate = {};
  const routeNames = new Set();

  for (const filename of files) {
    const date = parseDateFromFilename(filename);
    if (!date) {
      continue;
    }

    const byRoute = readDailyCrowding(path.join(ROOT, filename));
    byDate[date] = byRoute;
    Object.keys(byRoute).forEach((routeName) => routeNames.add(routeName));
  }

  return {
    dates: Object.keys(byDate).sort(),
    byDate,
    routeNames: Array.from(routeNames).sort((left, right) => left.localeCompare(right, 'ko')),
  };
}

function buildLatestAvailableCrowdingByRoute(crowding) {
  const latestByRoute = {};

  for (const date of crowding.dates) {
    for (const [routeName, stops] of Object.entries(crowding.byDate[date])) {
      latestByRoute[routeName] = {
        date,
        stops,
      };
    }
  }

  return latestByRoute;
}

async function streamCsv(filePath, onRow, encoding = 'utf8') {
  const input = fs.createReadStream(filePath, { encoding });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;

  for await (const line of reader) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }

    if (!line.trim()) {
      continue;
    }

    const values = parseCsvLine(line);
    const row = {};
    header.forEach((key, index) => {
      row[key] = values[index] ?? '';
    });
    await onRow(row);
  }
}

function buildRouteNameLookup(targetRouteNames) {
  const lookup = new Map();

  for (const routeName of targetRouteNames) {
    const names = new Set([routeName, ...(ROUTE_NAME_ALIASES[routeName] || [])]);
    for (const candidateName of names) {
      const routes = lookup.get(candidateName) || [];
      routes.push(routeName);
      lookup.set(candidateName, routes);
    }
  }

  return lookup;
}

async function findRouteCandidates(targetRouteNames) {
  const routeNameLookup = buildRouteNameLookup(targetRouteNames);
  const routes = {};

  await streamCsv(GTFS_FILES.routes, async (row) => {
    const routeShortName = row.route_short_name;
    const routeId = row.route_id;
    const sourceRouteNames = routeNameLookup.get(routeShortName);

    if (!sourceRouteNames?.length) {
      return;
    }

    const candidate = {
      routeId,
      agencyId: row.agency_id,
      routeShortName,
      routeLongName: row.route_long_name,
      routeType: row.route_type,
      isSeoulRoute: routeId.startsWith('BR_1100_'),
      aliasMatched: !sourceRouteNames.includes(routeShortName),
    };

    for (const sourceRouteName of sourceRouteNames) {
      (routes[sourceRouteName] ||= []).push(candidate);
    }
  });

  return routes;
}

async function findTrips(routeCandidatesBySourceRoute) {
  const routeIds = new Set(
    Object.values(routeCandidatesBySourceRoute)
      .flat()
      .map((route) => route.routeId),
  );
  const byRouteId = {};

  await streamCsv(GTFS_FILES.trips, async (row) => {
    if (!routeIds.has(row.route_id)) {
      return;
    }

    (byRouteId[row.route_id] ||= []).push({
      tripId: row.trip_id,
      serviceId: row.service_id,
      shapeId: row.shape_id,
      tripHeadsign: row.trip_headsign,
      directionId: row.direction_id,
    });
  });

  for (const routeId of Object.keys(byRouteId)) {
    byRouteId[routeId].sort((left, right) => left.tripId.localeCompare(right.tripId, 'ko'));
  }

  return byRouteId;
}

async function findStopTimes(tripsByRouteId) {
  const targetTrips = new Set(
    Object.values(tripsByRouteId)
      .flat()
      .map((trip) => trip.tripId),
  );
  const stopTimesByTrip = {};
  const stopIds = new Set();

  await streamCsv(GTFS_FILES.stopTimes, async (row) => {
    if (!targetTrips.has(row.trip_id)) {
      return;
    }

    const item = {
      tripId: row.trip_id,
      arrivalTime: row.arrival_time,
      departureTime: row.departure_time,
      stopId: row.stop_id,
      stopSequence: toNumber(row.stop_sequence),
    };

    (stopTimesByTrip[row.trip_id] ||= []).push(item);
    stopIds.add(row.stop_id);
  });

  for (const tripId of Object.keys(stopTimesByTrip)) {
    stopTimesByTrip[tripId].sort((left, right) => left.stopSequence - right.stopSequence);
  }

  return { stopTimesByTrip, stopIds };
}

async function findStops(stopIds) {
  const stops = {};

  await streamCsv(GTFS_FILES.stops, async (row) => {
    if (!stopIds.has(row.stop_id)) {
      return;
    }

    stops[row.stop_id] = {
      stopId: row.stop_id,
      stopName: row.stop_name,
      stopNameNormalized: normalizeStopName(row.stop_name),
      stopLat: Number(row.stop_lat),
      stopLon: Number(row.stop_lon),
    };
  });

  return stops;
}

function lcsMatch(localStops, gtfsStops) {
  const localCount = localStops.length;
  const gtfsCount = gtfsStops.length;
  const dp = Array.from({ length: localCount + 1 }, () => Array(gtfsCount + 1).fill(0));

  for (let localIndex = 1; localIndex <= localCount; localIndex += 1) {
    for (let gtfsIndex = 1; gtfsIndex <= gtfsCount; gtfsIndex += 1) {
      if (localStops[localIndex - 1].stopNameNormalized === gtfsStops[gtfsIndex - 1].stopNameNormalized) {
        dp[localIndex][gtfsIndex] = dp[localIndex - 1][gtfsIndex - 1] + 1;
      } else {
        dp[localIndex][gtfsIndex] = Math.max(dp[localIndex - 1][gtfsIndex], dp[localIndex][gtfsIndex - 1]);
      }
    }
  }

  const matches = [];
  let localIndex = localCount;
  let gtfsIndex = gtfsCount;

  while (localIndex > 0 && gtfsIndex > 0) {
    if (localStops[localIndex - 1].stopNameNormalized === gtfsStops[gtfsIndex - 1].stopNameNormalized) {
      matches.push([localIndex - 1, gtfsIndex - 1]);
      localIndex -= 1;
      gtfsIndex -= 1;
    } else if (dp[localIndex - 1][gtfsIndex] >= dp[localIndex][gtfsIndex - 1]) {
      localIndex -= 1;
    } else {
      gtfsIndex -= 1;
    }
  }

  return matches.reverse();
}

function expandMatchPairs(localStops, gtfsStops, basePairs) {
  const pairs = [...basePairs].sort((left, right) => left[0] - right[0]);
  const expanded = new Map(pairs.map(([localIndex, gtfsIndex]) => [localIndex, gtfsIndex]));
  const boundaries = [[-1, -1], ...pairs, [localStops.length, gtfsStops.length]];

  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const [prevLocal, prevGtfs] = boundaries[index];
    const [nextLocal, nextGtfs] = boundaries[index + 1];
    const localGap = nextLocal - prevLocal - 1;
    const gtfsGap = nextGtfs - prevGtfs - 1;

    if (localGap <= 0 || gtfsGap <= 0) {
      continue;
    }

    const assignCount = Math.min(localGap, gtfsGap);
    for (let offset = 0; offset < assignCount; offset += 1) {
      const localIndex = prevLocal + 1 + offset;
      const gtfsIndex = prevGtfs + 1 + offset;
      if (!expanded.has(localIndex)) {
        expanded.set(localIndex, gtfsIndex);
      }
    }
  }

  return Array.from(expanded.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([localIndex, gtfsIndex]) => [localIndex, gtfsIndex]);
}

function evaluateRouteCandidate(localStops, routeCandidate, trip, stopTimesByTrip, stopsById) {
  const gtfsStops = (stopTimesByTrip[trip.tripId] || []).map((stopTime) => ({
    ...stopTime,
    ...stopsById[stopTime.stopId],
  }));

  if (!gtfsStops.length) {
    return null;
  }

  const nameMatchPairs = lcsMatch(localStops, gtfsStops);
  const matchPairs = expandMatchPairs(localStops, gtfsStops, nameMatchPairs);
  const gtfsByLocalIndex = new Map(matchPairs.map(([localIndex, gtfsIndex]) => [localIndex, gtfsStops[gtfsIndex]]));

  const stops = localStops.map((localStop, index) => {
    const gtfsStop = gtfsByLocalIndex.get(index) || null;
    return {
      sequence: localStop.sequence,
      terminal: localStop.terminal,
      localStopName: localStop.stopName,
      localStopNameNormalized: localStop.stopNameNormalized,
      gtfsStopId: gtfsStop?.stopId ?? '',
      gtfsStopName: gtfsStop?.stopName ?? '',
      gtfsStopSequence: gtfsStop?.stopSequence ?? null,
      stopLat: gtfsStop?.stopLat ?? null,
      stopLon: gtfsStop?.stopLon ?? null,
      matched: Boolean(gtfsStop),
    };
  });

  const localStopCount = localStops.length || 1;
  const exactNameBonus = routeCandidate.routeShortName === localStops[0]?.route ? 3 : 0;
  const seoulBonus = routeCandidate.isSeoulRoute ? 2 : 0;
  const directNameBonus = routeCandidate.aliasMatched ? 0 : 1;

  return {
    route: routeCandidate,
    trip,
    gtfsStops,
    nameMatchPairs,
    stops,
    score:
      nameMatchPairs.length * 10000 +
      round2((nameMatchPairs.length / localStopCount) * 100) +
      exactNameBonus +
      seoulBonus +
      directNameBonus,
  };
}

function buildRouteBases(latestCrowdingByRoute, routeCandidatesBySourceRoute, tripsByRouteId, stopTimesByTrip, stopsById) {
  const routes = [];
  const extractedRoutes = [];
  const extractedTrips = [];
  const extractedStopTimes = [];
  const extractedStops = new Map();

  for (const routeName of Object.keys(routeCandidatesBySourceRoute).sort((left, right) => left.localeCompare(right, 'ko'))) {
    const localStops = latestCrowdingByRoute[routeName] || [];
    if (!localStops.length) {
      continue;
    }

    let bestCandidate = null;

    for (const routeCandidate of routeCandidatesBySourceRoute[routeName] || []) {
      for (const trip of tripsByRouteId[routeCandidate.routeId] || []) {
        const evaluated = evaluateRouteCandidate(localStops, routeCandidate, trip, stopTimesByTrip, stopsById);
        if (evaluated && (!bestCandidate || evaluated.score > bestCandidate.score)) {
          bestCandidate = evaluated;
        }
      }
    }

    if (!bestCandidate) {
      continue;
    }

    const { route, trip, gtfsStops, nameMatchPairs, stops } = bestCandidate;

    routes.push({
      routeName,
      matchedRouteShortName: route.routeShortName,
      routeId: route.routeId,
      routeLongName: route.routeLongName,
      routeType: route.routeType,
      tripId: trip.tripId,
      shapeId: trip.shapeId,
      stopCountLocal: localStops.length,
      stopCountGtfs: gtfsStops.length,
      matchedStopCount: nameMatchPairs.length,
      matchRate: round2((nameMatchPairs.length / localStops.length) * 100),
      stops,
    });

    extractedRoutes.push({
      route_short_name: routeName,
      matched_route_short_name: route.routeShortName,
      route_id: route.routeId,
      agency_id: route.agencyId,
      route_long_name: route.routeLongName,
      route_type: route.routeType,
    });

    extractedTrips.push({
      route_id: route.routeId,
      trip_id: trip.tripId,
      service_id: trip.serviceId,
      shape_id: trip.shapeId,
    });

    for (const stopTime of gtfsStops) {
      extractedStopTimes.push({
        trip_id: stopTime.tripId,
        arrival_time: stopTime.arrivalTime,
        departure_time: stopTime.departureTime,
        stop_id: stopTime.stopId,
        stop_sequence: stopTime.stopSequence,
      });

      if (!extractedStops.has(stopTime.stopId)) {
        extractedStops.set(stopTime.stopId, {
          stop_id: stopTime.stopId,
          stop_name: stopTime.stopName,
          stop_lat: stopTime.stopLat,
          stop_lon: stopTime.stopLon,
        });
      }
    }
  }

  return {
    routes,
    extractedRoutes,
    extractedTrips,
    extractedStopTimes,
    extractedStops: Array.from(extractedStops.values()),
  };
}

function buildSnapshotFromDailyStops(routeBase, localStops, date, type) {
  const localBySequence = new Map((localStops || []).map((stop) => [stop.sequence, stop]));
  const stopPassengers = routeBase.stops.map((stop) => {
    const localStop = localBySequence.get(stop.sequence);
    return localStop ? [...localStop.passengersByHour] : Array(HOUR_COLUMNS.length).fill(0);
  });

  const averagePassengers = HOUR_COLUMNS.map((_, hourIndex) => {
    const total = stopPassengers.reduce((sum, stop) => sum + stop[hourIndex], 0);
    return stopPassengers.length ? total / stopPassengers.length : 0;
  });

  return {
    date,
    type,
    label: formatDateLabel(date),
    weekdayIndex: getWeekdayIndex(date),
    averages: averagePassengers.map((value) => passengersToCrowding(value)),
    averagePassengers: averagePassengers.map((value) => round2(value)),
    stopPassengers,
  };
}

function weightedAverage(values) {
  if (!values.length) {
    return null;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  values.forEach((value, index) => {
    const weight = index + 1;
    weightedSum += value * weight;
    totalWeight += weight;
  });

  return totalWeight ? weightedSum / totalWeight : null;
}

function average(values) {
  if (!values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function predictSeriesValue(series, weekdayIndex, fallback = 0) {
  if (!series.length) {
    return fallback;
  }

  const recent = series.slice(-6).map((entry) => entry.value);
  const sameWeekday = series
    .filter((entry) => entry.weekdayIndex === weekdayIndex)
    .slice(-6)
    .map((entry) => entry.value);

  const recentAverage = weightedAverage(recent);
  const sameWeekdayAverage = weightedAverage(sameWeekday);
  const lastValue = series[series.length - 1].value;
  const deltas = [];

  for (let index = 1; index < Math.min(series.length, 6); index += 1) {
    const current = series[series.length - index].value;
    const previous = series[series.length - index - 1]?.value;
    if (previous == null) {
      break;
    }
    deltas.push(current - previous);
  }

  const trend = deltas.length ? lastValue + average(deltas) : lastValue;
  const candidates = [];

  if (sameWeekdayAverage != null) {
    candidates.push({ value: sameWeekdayAverage, weight: 0.45 });
  }
  if (recentAverage != null) {
    candidates.push({ value: recentAverage, weight: 0.35 });
  }
  if (Number.isFinite(trend)) {
    candidates.push({ value: trend, weight: 0.2 });
  }

  if (!candidates.length) {
    return fallback;
  }

  const weightSum = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  const predicted = candidates.reduce((sum, candidate) => sum + candidate.value * candidate.weight, 0) / weightSum;
  return clamp(predicted, 0, Math.max(fallback, predicted * 1.3, lastValue * 1.4, 1));
}

function createHistory(routeBase, actualSnapshots) {
  const stopCount = routeBase.stops.length;
  const stopPassengerSeries = Array.from({ length: stopCount }, () =>
    Array.from({ length: HOUR_COLUMNS.length }, () => []),
  );
  const stopShareSeries = Array.from({ length: stopCount }, () =>
    Array.from({ length: HOUR_COLUMNS.length }, () => []),
  );
  const routeAverageSeries = Array.from({ length: HOUR_COLUMNS.length }, () => []);

  const addSnapshot = (snapshot) => {
    for (let hourIndex = 0; hourIndex < HOUR_COLUMNS.length; hourIndex += 1) {
      const routeAveragePassenger = snapshot.averagePassengers[hourIndex];
      routeAverageSeries[hourIndex].push({
        date: snapshot.date,
        weekdayIndex: snapshot.weekdayIndex,
        value: routeAveragePassenger,
      });

      for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
        const passengers = snapshot.stopPassengers[stopIndex][hourIndex];
        const share = routeAveragePassenger > 0 ? passengers / routeAveragePassenger : 1;

        stopPassengerSeries[stopIndex][hourIndex].push({
          date: snapshot.date,
          weekdayIndex: snapshot.weekdayIndex,
          value: passengers,
        });
        stopShareSeries[stopIndex][hourIndex].push({
          date: snapshot.date,
          weekdayIndex: snapshot.weekdayIndex,
          value: share,
        });
      }
    }
  };

  actualSnapshots.forEach(addSnapshot);

  return {
    stopPassengerSeries,
    stopShareSeries,
    routeAverageSeries,
    addSnapshot,
  };
}

function buildPredictedSnapshot(routeBase, history, date) {
  const weekdayIndex = getWeekdayIndex(date);
  const stopCount = routeBase.stops.length;
  const predictedRouteAverages = HOUR_COLUMNS.map((_, hourIndex) =>
    predictSeriesValue(history.routeAverageSeries[hourIndex], weekdayIndex, 0),
  );

  const stopPassengers = Array.from({ length: stopCount }, () => Array(HOUR_COLUMNS.length).fill(0));

  for (let hourIndex = 0; hourIndex < HOUR_COLUMNS.length; hourIndex += 1) {
    const directPredictions = [];
    const sharePredictions = [];

    for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
      const recentStopSeries = history.stopPassengerSeries[stopIndex][hourIndex];
      const shareSeries = history.stopShareSeries[stopIndex][hourIndex];
      const directPrediction = predictSeriesValue(recentStopSeries, weekdayIndex, predictedRouteAverages[hourIndex]);
      const sharePrediction = predictSeriesValue(shareSeries, weekdayIndex, 1);

      directPredictions.push(directPrediction);
      sharePredictions.push(sharePrediction);
    }

    const meanShare = average(sharePredictions) || 1;

    for (let stopIndex = 0; stopIndex < stopCount; stopIndex += 1) {
      const normalizedShare = sharePredictions[stopIndex] / meanShare;
      const routeBlendedPrediction = predictedRouteAverages[hourIndex] * normalizedShare;
      const finalPrediction = Math.round(Math.max(0, directPredictions[stopIndex] * 0.65 + routeBlendedPrediction * 0.35));
      stopPassengers[stopIndex][hourIndex] = finalPrediction;
    }
  }

  const averagePassengers = HOUR_COLUMNS.map((_, hourIndex) => {
    const total = stopPassengers.reduce((sum, stop) => sum + stop[hourIndex], 0);
    return stopCount ? total / stopCount : 0;
  });

  return {
    date,
    type: 'predicted',
    label: formatDateLabel(date),
    weekdayIndex,
    averages: averagePassengers.map((value) => passengersToCrowding(value)),
    averagePassengers: averagePassengers.map((value) => round2(value)),
    stopPassengers,
  };
}

function hasMeaningfulCrowding(actualSnapshots) {
  return actualSnapshots.some((snapshot) =>
    snapshot.averagePassengers.some((value) => value > 0),
  );
}

function buildTimeline(actualDates, futureDates) {
  return [
    ...actualDates.map((date) => ({
      date,
      type: 'actual',
      label: formatDateLabel(date),
    })),
    ...futureDates.map((date) => ({
    date,
    type: 'predicted',
    label: formatDateLabel(date),
    })),
  ];
}

function toCsv(rows) {
  if (!rows.length) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    const string = String(value ?? '');
    if (/[",\n]/.test(string)) {
      return `"${string.replace(/"/g, '""')}"`;
    }
    return string;
  };

  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n');
}

function toLegacyRouteSnapshot(route, snapshot) {
  const stops = route.stops.map((stop, stopIndex) => {
    const hourly = {};

    HOUR_COLUMNS.forEach((hour, hourIndex) => {
      const passengers = snapshot.stopPassengers[stopIndex][hourIndex];
      hourly[hour] = {
        passengers,
        crowding: passengersToCrowding(passengers),
      };
    });

    return {
      ...stop,
      hourly,
    };
  });

  return {
    routeName: route.routeName,
    routeId: route.routeId,
    routeLongName: route.routeLongName,
    routeType: route.routeType,
    tripId: route.tripId,
    shapeId: route.shapeId,
    stopCountLocal: route.stopCountLocal,
    stopCountGtfs: route.stopCountGtfs,
    matchedStopCount: route.matchedStopCount,
    matchRate: route.matchRate,
    averages: Object.fromEntries(HOUR_COLUMNS.map((hour, index) => [hour, snapshot.averages[index]])),
    stops,
  };
}

function renderHtml(latestRoutes, snapshotLabel) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>서울 버스 혼잡 예측 요약</title>
  <style>
    body { font-family: "Segoe UI", "Malgun Gothic", sans-serif; margin: 0; background: #f6f1e8; color: #17202a; }
    .page { max-width: 1280px; margin: 0 auto; padding: 32px 20px 40px; }
    .hero { background: #fffaf2; border: 1px solid #d8d0c4; border-radius: 24px; padding: 24px; }
    .hero h1 { margin: 0 0 8px; }
    .hero p { margin: 0; color: #57616b; line-height: 1.5; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 20px; }
    .card { background: #fffaf2; border: 1px solid #d8d0c4; border-radius: 20px; padding: 18px; }
    .card h2 { margin: 0 0 8px; font-size: 20px; }
    .card strong { font-size: 28px; }
    ul { padding-left: 18px; margin: 12px 0 0; }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <h1>서울 버스 혼잡 예측 요약</h1>
      <p>정적 HTML에는 최신 예측 요약만 제공합니다. 전체 인터랙티브 맵과 LLM 분석 기능은 React 프론트엔드에서 확인할 수 있습니다.</p>
      <p style="margin-top: 8px;"><strong>기준 예측일</strong> ${snapshotLabel}</p>
    </section>
    <section class="grid">
      ${latestRoutes
        .map((route) => {
          const topStops = [...route.stops]
            .map((stop) => ({
              name: stop.localStopName,
              peak: Math.max(...Object.values(stop.hourly).map((hour) => hour.crowding)),
            }))
            .sort((left, right) => right.peak - left.peak)
            .slice(0, 3);

          return `
            <article class="card">
              <h2>${route.routeName}</h2>
              <p>정류장 ${route.stopCountLocal}개, GTFS 매칭률 ${route.matchRate}%</p>
              <strong>${Math.max(...Object.values(route.averages)).toFixed(2)}%</strong>
              <p>예측 기준 최고 평균 혼잡도</p>
              <ul>
                ${topStops.map((stop) => `<li>${stop.name}: ${stop.peak.toFixed(2)}%</li>`).join('')}
              </ul>
            </article>
          `;
        })
        .join('')}
    </section>
  </div>
</body>
</html>`;
}

async function main() {
  ensureDir(OUTPUT_DIR);
  ensureDir(FRONTEND_DATA_DIR);

  const crowding = readAllCrowding();
  const latestActualDate = crowding.dates[crowding.dates.length - 1];
  const futureDates = Array.from({ length: PREDICTION_DAYS }, (_, index) => addDays(latestActualDate, index + 1));
  const missingActualDates = getMissingDates(crowding.dates);
  const latestAvailableCrowdingByRoute = buildLatestAvailableCrowdingByRoute(crowding);
  const targetRouteNames = new Set(crowding.routeNames);

  const routeCandidatesBySourceRoute = await findRouteCandidates(targetRouteNames);
  const tripsByRouteId = await findTrips(routeCandidatesBySourceRoute);
  const { stopTimesByTrip, stopIds } = await findStopTimes(tripsByRouteId);
  const stopsById = await findStops(stopIds);
  const routeBases = buildRouteBases(
    Object.fromEntries(
      Object.entries(latestAvailableCrowdingByRoute).map(([routeName, value]) => [routeName, value.stops]),
    ),
    routeCandidatesBySourceRoute,
    tripsByRouteId,
    stopTimesByTrip,
    stopsById,
  );

  const excludedRoutesWithZeroCrowding = [];
  const routes = routeBases.routes.flatMap((routeBase) => {
    const actualSnapshots = crowding.dates.map((date) =>
      buildSnapshotFromDailyStops(routeBase, crowding.byDate[date][routeBase.routeName], date, 'actual'),
    );
    if (!hasMeaningfulCrowding(actualSnapshots)) {
      excludedRoutesWithZeroCrowding.push(routeBase.routeName);
      return [];
    }

    const history = createHistory(routeBase, actualSnapshots);
    const predictedSnapshots = futureDates.map((date) => {
      const snapshot = buildPredictedSnapshot(routeBase, history, date);
      history.addSnapshot(snapshot);
      return snapshot;
    });

    return [{
      ...routeBase,
      snapshots: [...actualSnapshots, ...predictedSnapshots],
    }];
  });

  const matchedRouteNames = new Set(routes.map((route) => route.routeName));
  const missingRoutesInGtfs = crowding.routeNames.filter((routeName) => !matchedRouteNames.has(routeName));

  const dataset = {
    generatedAt: new Date().toISOString(),
    busCapacity: BUS_CAPACITY,
    hours: HOUR_COLUMNS,
    actualDates: crowding.dates,
    futureDates,
    latestActualDate,
    missingActualDates,
    sourceRouteCount: crowding.routeNames.length,
    matchedRouteCount: routes.length,
    missingRoutesInGtfs,
    excludedRoutesWithZeroCrowding,
    model: {
      name: 'seasonal-recency-routeblend-v1',
      description:
        '최근 관측값, 같은 요일 패턴, 노선 평균 추세, 정류장별 상대 패턴을 함께 반영하는 하이브리드 예측 모델',
      predictionHorizonDays: PREDICTION_DAYS,
      trainingDateCount: crowding.dates.length,
      features: [
        'same-weekday stop/hour pattern',
        'recent stop/hour recency trend',
        'route-level hourly average trend',
        'stop-to-route relative share',
      ],
    },
    timeline: buildTimeline(crowding.dates, futureDates),
    routes,
  };

  const selectedRoutesJson = JSON.stringify(dataset, null, 2);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'selected_routes.json'), selectedRoutesJson, 'utf8');
  fs.writeFileSync(path.join(FRONTEND_DATA_DIR, 'selected_routes.json'), selectedRoutesJson, 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'seoul_gtfs_routes.csv'), toCsv(routeBases.extractedRoutes), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'seoul_gtfs_trips.csv'), toCsv(routeBases.extractedTrips), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'seoul_gtfs_stop_times.csv'), toCsv(routeBases.extractedStopTimes), 'utf8');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'seoul_gtfs_stops.csv'), toCsv(routeBases.extractedStops), 'utf8');

  const latestSnapshotLabel = dataset.timeline[dataset.timeline.length - 1].label;
  const legacyLatestRoutes = routes.map((route) => toLegacyRouteSnapshot(route, route.snapshots[route.snapshots.length - 1]));
  fs.writeFileSync(path.join(OUTPUT_DIR, 'seoul_bus_visualization.html'), renderHtml(legacyLatestRoutes, latestSnapshotLabel), 'utf8');

  const summary = {
    sourceRouteCount: dataset.sourceRouteCount,
    matchedRouteCount: dataset.matchedRouteCount,
    missingRoutesInGtfs: dataset.missingRoutesInGtfs,
    excludedRoutesWithZeroCrowding: dataset.excludedRoutesWithZeroCrowding,
    actualDates: dataset.actualDates,
    missingActualDates: dataset.missingActualDates,
    futureDates: dataset.futureDates,
    model: dataset.model.name,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
