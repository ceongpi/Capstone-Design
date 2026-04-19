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
const CSV_FILE_PATTERN = /^노선·정류장 지표\(노선별 차내 재차인원\)_(\d{8})\.csv$/;
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

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
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
    .replace(/[.\-·,/]/g, '')
    .replace(/\s+/g, '')
    .replace(/서울북부지방법원검찰청입구성당/g, '서울북부지방법원검찰청입구')
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

function getWeekdayIndex(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function formatDateLabel(dateString, type) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const base = new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    timeZone: KOREAN_TIMEZONE,
  }).format(date);
  return `${base} ${type === 'actual' ? '실측' : '예측'}`;
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
  const header = parseCsvLine(lines[0]);
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
    const route = row['노선'];
    if (!route) {
      continue;
    }

    const passengersByHour = HOUR_COLUMNS.map((hour) => toNumber(row[hour]));
    (byRoute[route] ||= []).push({
      route,
      terminal: row['기종점'],
      sequence: toNumber(row['정류장순번']),
      stopName: row['정류장명'],
      stopNameNormalized: normalizeStopName(row['정류장명']),
      passengersByHour,
    });
  }

  for (const route of Object.keys(byRoute)) {
    byRoute[route].sort((a, b) => a.sequence - b.sequence);
  }

  return byRoute;
}

function readAllCrowding() {
  const files = getCrowdingCsvFiles();
  if (!files.length) {
    throw new Error('스마트카드 CSV 파일을 찾을 수 없습니다.');
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
    stopTimesByTrip[tripId].sort((a, b) => a.stopSequence - b.stopSequence);
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
  const n = localStops.length;
  const m = gtfsStops.length;
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (localStops[i - 1].stopNameNormalized === gtfsStops[j - 1].stopNameNormalized) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const matches = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (localStops[i - 1].stopNameNormalized === gtfsStops[j - 1].stopNameNormalized) {
      matches.push([i - 1, j - 1]);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }

  return matches.reverse();
}

function expandMatchPairs(localStops, gtfsStops, basePairs) {
  const pairs = [...basePairs].sort((a, b) => a[0] - b[0]);
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
    .sort((a, b) => a[0] - b[0])
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
    matchPairs,
    stops,
    score:
      nameMatchPairs.length * 10000 +
      matchPairs.length * 10 +
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
        if (!evaluated) {
          continue;
        }

        if (!bestCandidate || evaluated.score > bestCandidate.score) {
          bestCandidate = evaluated;
        }
      }
    }

    if (!bestCandidate) {
      continue;
    }

    const { route, trip, gtfsStops, nameMatchPairs, matchPairs, stops } = bestCandidate;

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
    if (!localStop) {
      return Array(HOUR_COLUMNS.length).fill(0);
    }
    return [...localStop.passengersByHour];
  });

  const averages = HOUR_COLUMNS.map((_, hourIndex) => {
    const total = stopPassengers.reduce((sum, stop) => sum + stop[hourIndex], 0);
    return round2(passengersToCrowding(total / stopPassengers.length));
  });

  return {
    date,
    type,
    label: formatDateLabel(date, type),
    weekdayIndex: getWeekdayIndex(date),
    averages,
    stopPassengers,
  };
}

function createStatsBucket(length) {
  return Array.from({ length }, () => ({ sum: 0, count: 0 }));
}

function buildPredictionStats(actualSnapshots) {
  const stopCount = actualSnapshots[0]?.stopPassengers.length ?? 0;
  const weekdayStopHour = Array.from({ length: 7 }, () =>
    Array.from({ length: stopCount }, () => createStatsBucket(HOUR_COLUMNS.length)),
  );
  const stopHour = Array.from({ length: stopCount }, () => createStatsBucket(HOUR_COLUMNS.length));
  const weekdayRouteHour = Array.from({ length: 7 }, () => createStatsBucket(HOUR_COLUMNS.length));
  const routeHour = createStatsBucket(HOUR_COLUMNS.length);

  for (const snapshot of actualSnapshots) {
    for (let stopIndex = 0; stopIndex < snapshot.stopPassengers.length; stopIndex += 1) {
      for (let hourIndex = 0; hourIndex < HOUR_COLUMNS.length; hourIndex += 1) {
        const passengers = snapshot.stopPassengers[stopIndex][hourIndex];

        const weekdayStopCell = weekdayStopHour[snapshot.weekdayIndex][stopIndex][hourIndex];
        weekdayStopCell.sum += passengers;
        weekdayStopCell.count += 1;

        const stopCell = stopHour[stopIndex][hourIndex];
        stopCell.sum += passengers;
        stopCell.count += 1;

        const weekdayRouteCell = weekdayRouteHour[snapshot.weekdayIndex][hourIndex];
        weekdayRouteCell.sum += passengers;
        weekdayRouteCell.count += 1;

        const routeCell = routeHour[hourIndex];
        routeCell.sum += passengers;
        routeCell.count += 1;
      }
    }
  }

  return {
    weekdayStopHour,
    stopHour,
    weekdayRouteHour,
    routeHour,
  };
}

function averageFromCell(cell) {
  return cell.count ? cell.sum / cell.count : null;
}

function buildPredictedSnapshot(routeBase, stats, date) {
  const weekdayIndex = getWeekdayIndex(date);
  const stopPassengers = routeBase.stops.map((_, stopIndex) =>
    HOUR_COLUMNS.map((_, hourIndex) => {
      const weekdayStopValue = averageFromCell(stats.weekdayStopHour[weekdayIndex][stopIndex][hourIndex]);
      const stopValue = averageFromCell(stats.stopHour[stopIndex][hourIndex]);
      const weekdayRouteValue = averageFromCell(stats.weekdayRouteHour[weekdayIndex][hourIndex]);
      const routeValue = averageFromCell(stats.routeHour[hourIndex]);

      const predicted = weekdayStopValue ?? stopValue ?? weekdayRouteValue ?? routeValue ?? 0;
      return Math.max(0, Math.round(predicted));
    }),
  );

  const averages = HOUR_COLUMNS.map((_, hourIndex) => {
    const total = stopPassengers.reduce((sum, stop) => sum + stop[hourIndex], 0);
    return round2(passengersToCrowding(total / stopPassengers.length));
  });

  return {
    date,
    type: 'predicted',
    label: formatDateLabel(date, 'predicted'),
    weekdayIndex,
    averages,
    stopPassengers,
  };
}

function buildTimeline(actualDates, futureDates) {
  return [
    ...actualDates.map((date) => ({
      date,
      type: 'actual',
      label: formatDateLabel(date, 'actual'),
    })),
    ...futureDates.map((date) => ({
      date,
      type: 'predicted',
      label: formatDateLabel(date, 'predicted'),
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
  <title>서울 버스 혼잡 요약</title>
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
      <h1>서울 버스 혼잡도 요약</h1>
      <p>정적 HTML에는 최신 스냅샷 요약만 제공합니다. 전체 인터랙션과 미래 예측은 React 프론트엔드에서 확인할 수 있습니다.</p>
      <p style="margin-top: 8px;"><strong>기준 스냅샷:</strong> ${snapshotLabel}</p>
    </section>
    <section class="grid">
      ${latestRoutes
        .map((route) => {
          const topStops = [...route.stops]
            .map((stop) => ({
              name: stop.localStopName,
              peak: Math.max(...Object.values(stop.hourly).map((hour) => hour.crowding)),
            }))
            .sort((a, b) => b.peak - a.peak)
            .slice(0, 3);

          return `
            <article class="card">
              <h2>${route.routeName}</h2>
              <p>정류장 ${route.stopCountLocal}개, GTFS 매칭률 ${route.matchRate}%</p>
              <strong>${Math.max(...Object.values(route.averages)).toFixed(2)}%</strong>
              <p>하루 중 최고 평균 혼잡도</p>
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
  const targetRouteNames = new Set(crowding.routeNames);
  const latestActualDate = crowding.dates[crowding.dates.length - 1];
  const latestAvailableCrowdingByRoute = buildLatestAvailableCrowdingByRoute(crowding);
  const futureDates = Array.from({ length: PREDICTION_DAYS }, (_, index) => addDays(latestActualDate, index + 1));

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

  const routes = routeBases.routes.map((routeBase) => {
    const actualSnapshots = crowding.dates.map((date) =>
      buildSnapshotFromDailyStops(routeBase, crowding.byDate[date][routeBase.routeName], date, 'actual'),
    );
    const stats = buildPredictionStats(actualSnapshots);
    const predictedSnapshots = futureDates.map((date) => buildPredictedSnapshot(routeBase, stats, date));

    return {
      ...routeBase,
      snapshots: [...actualSnapshots, ...predictedSnapshots],
    };
  });

  const matchedRouteNames = new Set(routes.map((route) => route.routeName));
  const missingInGtfs = crowding.routeNames.filter((routeName) => !matchedRouteNames.has(routeName));

  const dataset = {
    generatedAt: new Date().toISOString(),
    busCapacity: BUS_CAPACITY,
    hours: HOUR_COLUMNS,
    actualDates: crowding.dates,
    futureDates,
    latestActualDate,
    sourceRouteCount: crowding.routeNames.length,
    matchedRouteCount: routes.length,
    missingRoutesInGtfs: missingInGtfs,
    model: {
      name: 'weekday-stop-hour-baseline',
      description: '같은 요일, 같은 시간, 같은 노선과 정류장의 평균을 우선 사용하는 베이스라인 예측',
      predictionHorizonDays: PREDICTION_DAYS,
      trainingDateCount: crowding.dates.length,
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
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'seoul_bus_visualization.html'),
    renderHtml(legacyLatestRoutes, latestSnapshotLabel),
    'utf8',
  );

  const summary = {
    sourceRouteCount: dataset.sourceRouteCount,
    matchedRouteCount: dataset.matchedRouteCount,
    missingRoutesInGtfs: dataset.missingRoutesInGtfs,
    actualDates: dataset.actualDates,
    futureDates: dataset.futureDates,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
