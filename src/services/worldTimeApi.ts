import * as THREE from 'three';

export type TimeOfDayPhase = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT';

export type WeatherCondition =
  | 'CLEAR'
  | 'CLOUDY'
  | 'DRIZZLE'
  | 'HEAVY_RAIN'
  | 'TORRENTIAL';

export type WeatherOverrideMode = 'LIVE' | WeatherCondition;

export interface WorldWeatherState {
  condition: WeatherCondition;
  label: string;
  rainIntensity: number; // 0 (dry), 0.30 (drizzle), 0.68 (heavy rain), 1.0 (torrential)
  cloudCover: number; // 0..1
  cloudDarkness: number; // 0..1
  hasLightning: boolean;
  rainfallMm: number | null;
  sourceLabel: 'data.gov.sg' | 'open-meteo' | 'preset' | 'fallback';
}

export interface CountryTimeOption {
  id: string;
  code: string;
  label: string;
  city: string;
  timezone: string;
  latitude: number;
  longitude: number;
  usesDataGovSg?: boolean;
}

export const COUNTRY_TIME_OPTIONS: CountryTimeOption[] = [
  {
    id: 'SG',
    code: 'SG',
    label: 'Singapore (data.gov.sg)',
    city: 'Singapore',
    timezone: 'Asia/Singapore',
    latitude: 1.3521,
    longitude: 103.8198,
    usesDataGovSg: true,
  },
  {
    id: 'JP',
    code: 'JP',
    label: 'Japan · Tokyo',
    city: 'Tokyo',
    timezone: 'Asia/Tokyo',
    latitude: 35.6762,
    longitude: 139.6503,
  },
  {
    id: 'KR',
    code: 'KR',
    label: 'South Korea · Seoul',
    city: 'Seoul',
    timezone: 'Asia/Seoul',
    latitude: 37.5665,
    longitude: 126.978,
  },
  {
    id: 'AU',
    code: 'AU',
    label: 'Australia · Sydney',
    city: 'Sydney',
    timezone: 'Australia/Sydney',
    latitude: -33.8688,
    longitude: 151.2093,
  },
  {
    id: 'AE',
    code: 'AE',
    label: 'UAE · Dubai',
    city: 'Dubai',
    timezone: 'Asia/Dubai',
    latitude: 25.2048,
    longitude: 55.2708,
  },
  {
    id: 'GB',
    code: 'GB',
    label: 'UK · London',
    city: 'London',
    timezone: 'Europe/London',
    latitude: 51.5072,
    longitude: -0.1276,
  },
  {
    id: 'FR',
    code: 'FR',
    label: 'France · Paris',
    city: 'Paris',
    timezone: 'Europe/Paris',
    latitude: 48.8566,
    longitude: 2.3522,
  },
  {
    id: 'US_NY',
    code: 'US',
    label: 'USA · New York',
    city: 'New York',
    timezone: 'America/New_York',
    latitude: 40.7128,
    longitude: -74.006,
  },
  {
    id: 'US_LA',
    code: 'US',
    label: 'USA · Los Angeles',
    city: 'Los Angeles',
    timezone: 'America/Los_Angeles',
    latitude: 34.0522,
    longitude: -118.2437,
  },
];

export const HOURLY_SYNC_INTERVAL_MS = 60 * 60 * 1000;

export interface WorldTimeState {
  countryId: string;
  code: string;
  city: string;
  timezone: string;
  baseHourFloat: number;
  hourFloat: number;
  hour: number;
  minute: number;
  second: number;
  formattedTime: string;
  phase: TimeOfDayPhase;
  temperatureC: number | null;
  sourceLabel: 'data.gov.sg' | 'time.now' | 'local-tz';
  syncedAtMs: number;
  isFallback: boolean;
}

export interface EnvironmentTimeProfile {
  phase: TimeOfDayPhase;
  skyZenith: THREE.Color;
  skyHorizon: THREE.Color;
  skyGlow: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  keyColor: THREE.Color;
  keyIntensity: number;
  rimColor: THREE.Color;
  rimIntensity: number;
  sunDirection: THREE.Vector3;
  sunStrength: number;
  moonStrength: number;
  starVisibility: number;
  sunsetStrength: number;
  cloudCover: number;
  cloudDarkness: number;
  roomLightScale: number;
  lightsOn: boolean;
  exposure: number;
}

export function getCountryTimeOption(countryId: string): CountryTimeOption {
  return (
    COUNTRY_TIME_OPTIONS.find((c) => c.id === countryId) ?? COUNTRY_TIME_OPTIONS[0]
  );
}

export function classifyTimePhase(hourFloat: number): TimeOfDayPhase {
  const h = ((hourFloat % 24) + 24) % 24;
  if (h >= 5.5 && h < 12.0) return 'MORNING';
  if (h >= 12.0 && h < 17.0) return 'AFTERNOON';
  if (h >= 17.0 && h < 19.5) return 'EVENING';
  return 'NIGHT';
}

function formatHHMM(hour: number, minute: number): string {
  const hh = String(((hour % 24) + 24) % 24).padStart(2, '0');
  const mm = String(((minute % 60) + 60) % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseWallClockFromIso(iso: string): {
  hour: number;
  minute: number;
  second: number;
} | null {
  const match = iso.match(/T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  if (
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }
  return {
    hour: Math.max(0, Math.min(23, hour)),
    minute: Math.max(0, Math.min(59, minute)),
    second: Math.max(0, Math.min(59, second)),
  };
}

function buildTimeStateFromHMS(
  option: CountryTimeOption,
  hour: number,
  minute: number,
  second: number,
  sourceLabel: WorldTimeState['sourceLabel'],
  temperatureC: number | null,
  isFallback: boolean,
  syncedAtMs = Date.now()
): WorldTimeState {
  const hourFloat = hour + minute / 60 + second / 3600;
  return {
    countryId: option.id,
    code: option.code,
    city: option.city,
    timezone: option.timezone,
    baseHourFloat: hourFloat,
    hourFloat,
    hour,
    minute,
    second,
    formattedTime: formatHHMM(hour, minute),
    phase: classifyTimePhase(hourFloat),
    temperatureC,
    sourceLabel,
    syncedAtMs,
    isFallback,
  };
}

/** Immediate timezone clock snapshot using Intl so frame 1 never blocks on network. */
export function buildLocalTimezoneSnapshot(countryId: string): WorldTimeState {
  const option = getCountryTimeOption(countryId);
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: option.timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const getNum = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    const hour = getNum('hour') % 24;
    const minute = getNum('minute') % 60;
    const second = getNum('second') % 60;
    return buildTimeStateFromHMS(
      option,
      hour,
      minute,
      second,
      'local-tz',
      null,
      true,
      now.getTime()
    );
  } catch {
    return buildTimeStateFromHMS(
      option,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      'local-tz',
      null,
      true,
      now.getTime()
    );
  }
}

/** Advances clock smoothly between hourly API refreshes. */
export function advanceWorldTime(
  state: WorldTimeState,
  nowMs = Date.now()
): WorldTimeState {
  const elapsedHours = Math.max(0, (nowMs - state.syncedAtMs) / 3_600_000);
  const hourFloat = (((state.baseHourFloat + elapsedHours) % 24) + 24) % 24;
  const totalSec = Math.floor(hourFloat * 3600);
  const hour = Math.floor(totalSec / 3600) % 24;
  const minute = Math.floor((totalSec % 3600) / 60);
  const second = totalSec % 60;
  return {
    ...state,
    hourFloat,
    hour,
    minute,
    second,
    formattedTime: formatHHMM(hour, minute),
    phase: classifyTimePhase(hourFloat),
  };
}

interface DataGovSgAirTempResponse {
  code?: number;
  data?: {
    readings?: Array<{
      timestamp?: string;
      data?: Array<{ stationId?: string; value?: number }>;
    }>;
  };
}

interface TimeNowResponse {
  datetime?: string;
  timezone?: string;
}

/**
 * Pulls live real-time environment timestamp from:
 * 1) Singapore data.gov.sg v2 real-time API (when Singapore is selected)
 * 2) time.now public timezone API for global countries
 * Gracefully falls back to timezone-accurate Intl if offline.
 */
export async function fetchWorldTime(
  countryId: string,
  signal?: AbortSignal
): Promise<WorldTimeState> {
  const option = getCountryTimeOption(countryId);

  // Primary Singapore path: official data.gov.sg v2 Real-Time Air Temperature API
  if (option.usesDataGovSg) {
    try {
      const res = await fetch(
        'https://api-open.data.gov.sg/v2/real-time/api/air-temperature',
        { signal, cache: 'no-store' }
      );
      if (res.ok) {
        const json = (await res.json()) as DataGovSgAirTempResponse;
        const latestReading = json.data?.readings?.[0];
        const ts = latestReading?.timestamp;
        const stationValues = (latestReading?.data ?? [])
          .map((d) => d.value)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const avgTemp =
          stationValues.length > 0
            ? Math.round(
                (stationValues.reduce((a, b) => a + b, 0) / stationValues.length) *
                  10
              ) / 10
            : null;

        if (ts) {
          // data.gov.sg timestamp updates every ~1 min; compute current SGT seconds cleanly
          const parsedMs = Date.parse(ts);
          const nowMs = Date.now();
          const baseWall = parseWallClockFromIso(ts);
          if (baseWall) {
            const driftSec =
              Number.isFinite(parsedMs) && Math.abs(nowMs - parsedMs) < 12 * 3600 * 1000
                ? Math.max(0, Math.round((nowMs - parsedMs) / 1000))
                : 0;
            const totalWallSec =
              (baseWall.hour * 3600 +
                baseWall.minute * 60 +
                baseWall.second +
                driftSec) %
              86400;
            const h = Math.floor(totalWallSec / 3600);
            const m = Math.floor((totalWallSec % 3600) / 60);
            const s = totalWallSec % 60;
            return buildTimeStateFromHMS(
              option,
              h,
              m,
              s,
              'data.gov.sg',
              avgTemp,
              false,
              nowMs
            );
          }
        }
      }
    } catch {
      // Fall through cleanly to time.now / Intl fallback
    }
  }

  // Global country time path via time.now developer timezone endpoint
  try {
    const res = await fetch(
      `https://time.now/developer/api/timezone/${encodeURIComponent(option.timezone)}`,
      { signal, cache: 'no-store' }
    );
    if (res.ok) {
      const json = (await res.json()) as TimeNowResponse;
      if (json.datetime) {
        const wall = parseWallClockFromIso(json.datetime);
        if (wall) {
          return buildTimeStateFromHMS(
            option,
            wall.hour,
            wall.minute,
            wall.second,
            'time.now',
            null,
            false,
            Date.now()
          );
        }
      }
    }
  } catch {
    // Fall through to Intl fallback
  }

  return buildLocalTimezoneSnapshot(countryId);
}

export function buildWeatherStateFromCondition(
  condition: WeatherCondition,
  labelOverride?: string,
  rainfallMm: number | null = null,
  sourceLabel: WorldWeatherState['sourceLabel'] = 'preset'
): WorldWeatherState {
  switch (condition) {
    case 'DRIZZLE':
      return {
        condition,
        label: labelOverride ?? 'Drizzle',
        rainIntensity: 0.3,
        cloudCover: 0.72,
        cloudDarkness: 0.45,
        hasLightning: false,
        rainfallMm,
        sourceLabel,
      };
    case 'HEAVY_RAIN':
      return {
        condition,
        label: labelOverride ?? 'Heavy Rain',
        rainIntensity: 0.68,
        cloudCover: 0.88,
        cloudDarkness: 0.74,
        hasLightning: true,
        rainfallMm,
        sourceLabel,
      };
    case 'TORRENTIAL':
      return {
        condition,
        label: labelOverride ?? 'Torrential Storm',
        rainIntensity: 1.0,
        cloudCover: 0.98,
        cloudDarkness: 0.94,
        hasLightning: true,
        rainfallMm,
        sourceLabel,
      };
    case 'CLOUDY':
      return {
        condition,
        label: labelOverride ?? 'Overcast',
        rainIntensity: 0,
        cloudCover: 0.65,
        cloudDarkness: 0.3,
        hasLightning: false,
        rainfallMm,
        sourceLabel,
      };
    default:
      return {
        condition: 'CLEAR',
        label: labelOverride ?? 'Clear Sky',
        rainIntensity: 0,
        cloudCover: 0.16,
        cloudDarkness: 0.0,
        hasLightning: false,
        rainfallMm,
        sourceLabel,
      };
  }
}

interface DataGovSgRainfallResponse {
  data?: {
    readings?: Array<{
      data?: Array<{ stationId?: string; value?: number }>;
    }>;
  };
}

interface DataGovSgForecastResponse {
  data?: {
    items?: Array<{
      forecasts?: Array<{ area?: string; forecast?: string }>;
    }>;
  };
}

interface OpenMeteoCurrentResponse {
  current?: {
    weather_code?: number;
    precipitation?: number;
    rain?: number;
    showers?: number;
    cloud_cover?: number;
  };
}

function classifySingaporeForecastText(text: string): WeatherCondition {
  const lower = text.toLowerCase();
  if (lower.includes('heavy thundery') || lower.includes('torrential')) {
    return 'TORRENTIAL';
  }
  if (lower.includes('thundery') || lower.includes('heavy rain') || lower.includes('heavy showers')) {
    return 'HEAVY_RAIN';
  }
  if (lower.includes('moderate rain') || lower.includes('showers')) {
    return 'HEAVY_RAIN';
  }
  if (lower.includes('light rain') || lower.includes('drizzle') || lower.includes('passing showers')) {
    return 'DRIZZLE';
  }
  if (lower.includes('cloudy') || lower.includes('overcast') || lower.includes('hazy')) {
    return 'CLOUDY';
  }
  return 'CLEAR';
}

const CONDITION_SEVERITY: Record<WeatherCondition, number> = {
  CLEAR: 0,
  CLOUDY: 1,
  DRIZZLE: 2,
  HEAVY_RAIN: 3,
  TORRENTIAL: 4,
};

/**
 * Pulls live weather & rainfall intensity:
 * - Singapore (`SG`): official data.gov.sg v2 Rainfall + 2-Hour Weather Forecast APIs
 * - Other countries: Open-Meteo real-time WMO weather & precipitation API
 */
export async function fetchWorldWeather(
  countryId: string,
  signal?: AbortSignal
): Promise<WorldWeatherState> {
  const option = getCountryTimeOption(countryId);

  if (option.usesDataGovSg) {
    try {
      const [rainRes, forecastRes] = await Promise.all([
        fetch('https://api-open.data.gov.sg/v2/real-time/api/rainfall', {
          signal,
          cache: 'no-store',
        }),
        fetch('https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast', {
          signal,
          cache: 'no-store',
        }),
      ]);

      let maxMm = 0;
      let hasRainData = false;
      if (rainRes.ok) {
        const rainJson = (await rainRes.json()) as DataGovSgRainfallResponse;
        const vals = (rainJson.data?.readings?.[0]?.data ?? [])
          .map((d) => d.value)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (vals.length > 0) {
          hasRainData = true;
          maxMm = Math.max(...vals);
        }
      }

      let dominantForecast = '';
      if (forecastRes.ok) {
        const fcJson = (await forecastRes.json()) as DataGovSgForecastResponse;
        const forecasts = fcJson.data?.items?.[0]?.forecasts ?? [];
        const cityEntry = forecasts.find(
          (f) => f.area === 'City' || f.area === 'Tanglin' || f.area === 'Kallang'
        );
        // Count forecasts across stations and also prioritize active city/island rain
        const counts = new Map<string, number>();
        for (const f of forecasts) {
          if (!f.forecast) continue;
          counts.set(f.forecast, (counts.get(f.forecast) ?? 0) + 1);
        }
        let topText = cityEntry?.forecast ?? '';
        let topScore = -1;
        for (const [text, count] of counts.entries()) {
          const cond = classifySingaporeForecastText(text);
          const weighted = count + CONDITION_SEVERITY[cond] * 2;
          if (weighted > topScore) {
            topScore = weighted;
            topText = text;
          }
        }
        dominantForecast = topText || cityEntry?.forecast || 'Cloudy';
      }

      if (hasRainData || dominantForecast) {
        const rainCond: WeatherCondition =
          maxMm >= 4.5
            ? 'TORRENTIAL'
            : maxMm >= 1.2
              ? 'HEAVY_RAIN'
              : maxMm > 0.05
                ? 'DRIZZLE'
                : 'CLEAR';
        const fcCond = dominantForecast
          ? classifySingaporeForecastText(dominantForecast)
          : 'CLEAR';
        const finalCond =
          CONDITION_SEVERITY[rainCond] >= CONDITION_SEVERITY[fcCond]
            ? rainCond
            : fcCond;
        const hasThunder =
          finalCond === 'TORRENTIAL' ||
          dominantForecast.toLowerCase().includes('thundery');
        const built = buildWeatherStateFromCondition(
          finalCond,
          dominantForecast || undefined,
          Math.round(maxMm * 10) / 10,
          'data.gov.sg'
        );
        return {
          ...built,
          hasLightning: hasThunder || built.hasLightning,
        };
      }
    } catch {
      // Fall through cleanly to Open-Meteo
    }
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${option.latitude}&longitude=${option.longitude}&current=weather_code,precipitation,rain,showers,cloud_cover`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (res.ok) {
      const json = (await res.json()) as OpenMeteoCurrentResponse;
      const cur = json.current;
      if (cur) {
        const wmo = cur.weather_code ?? 0;
        const precip = Math.max(
          cur.precipitation ?? 0,
          (cur.rain ?? 0) + (cur.showers ?? 0)
        );
        const cloudPct = THREE.MathUtils.clamp((cur.cloud_cover ?? 20) / 100, 0, 1);

        let condition: WeatherCondition = 'CLEAR';
        let label = 'Clear Sky';
        let hasLightning = false;

        if (wmo >= 95 || precip >= 7.5) {
          condition = 'TORRENTIAL';
          label = wmo >= 95 ? 'Thunderstorm' : 'Torrential Rain';
          hasLightning = true;
        } else if (wmo === 65 || wmo === 82 || precip >= 2.2) {
          condition = 'TORRENTIAL';
          label = 'Torrential Downpour';
          hasLightning = precip >= 4.0;
        } else if (wmo === 63 || wmo === 81 || precip >= 0.8) {
          condition = 'HEAVY_RAIN';
          label = 'Heavy Rain';
          hasLightning = precip >= 1.5;
        } else if (
          (wmo >= 51 && wmo <= 61) ||
          wmo === 80 ||
          precip > 0.04
        ) {
          condition = 'DRIZZLE';
          label = wmo >= 51 && wmo <= 57 ? 'Drizzle' : 'Light Rain';
        } else if (wmo === 2 || wmo === 3 || wmo === 45 || wmo === 48 || cloudPct >= 0.5) {
          condition = 'CLOUDY';
          label = wmo === 45 || wmo === 48 ? 'Misty / Fog' : 'Cloudy';
        } else if (wmo === 1) {
          condition = 'CLEAR';
          label = 'Partly Clear';
        }

        const built = buildWeatherStateFromCondition(
          condition,
          label,
          Math.round(precip * 10) / 10,
          'open-meteo'
        );
        return {
          ...built,
          cloudCover: Math.max(built.cloudCover, cloudPct),
          hasLightning: hasLightning || built.hasLightning,
        };
      }
    }
  } catch {
    // Fall through to dry/clear fallback
  }

  return buildWeatherStateFromCondition('CLEAR', 'Clear Sky', 0, 'fallback');
}

interface KeyframeStop {
  hour: number;
  skyZenith: THREE.Color;
  skyHorizon: THREE.Color;
  skyGlow: THREE.Color;
  fogColor: THREE.Color;
  fogDensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  keyColor: THREE.Color;
  keyIntensity: number;
  rimColor: THREE.Color;
  rimIntensity: number;
  sunStrength: number;
  moonStrength: number;
  starVisibility: number;
  sunsetStrength: number;
  roomLightScale: number;
  exposure: number;
}

const TIME_KEYFRAMES: KeyframeStop[] = [
  {
    hour: 0.0, // Midnight (Dark Night, lights ON)
    skyZenith: new THREE.Color(0x03060d),
    skyHorizon: new THREE.Color(0x0c1424),
    skyGlow: new THREE.Color(0x16243f),
    fogColor: new THREE.Color(0x06090e),
    fogDensity: 0.021,
    hemiSky: new THREE.Color(0x4b6a99),
    hemiGround: new THREE.Color(0x0b0f17),
    hemiIntensity: 0.22,
    keyColor: new THREE.Color(0x7ca2ff),
    keyIntensity: 0.30,
    rimColor: new THREE.Color(0x00d8f0),
    rimIntensity: 0.34,
    sunStrength: 0.0,
    moonStrength: 1.0,
    starVisibility: 1.0,
    sunsetStrength: 0.0,
    roomLightScale: 1.48,
    exposure: 1.18,
  },
  {
    hour: 5.0, // Pre-dawn Night
    skyZenith: new THREE.Color(0x050914),
    skyHorizon: new THREE.Color(0x131d33),
    skyGlow: new THREE.Color(0x2a243d),
    fogColor: new THREE.Color(0x080c15),
    fogDensity: 0.019,
    hemiSky: new THREE.Color(0x5573a1),
    hemiGround: new THREE.Color(0x0c111a),
    hemiIntensity: 0.26,
    keyColor: new THREE.Color(0x88a8f0),
    keyIntensity: 0.34,
    rimColor: new THREE.Color(0x25c4e6),
    rimIntensity: 0.32,
    sunStrength: 0.05,
    moonStrength: 0.85,
    starVisibility: 0.82,
    sunsetStrength: 0.15,
    roomLightScale: 1.32,
    exposure: 1.16,
  },
  {
    hour: 6.5, // Dawn / Early Morning Sunrise
    skyZenith: new THREE.Color(0x2a548d),
    skyHorizon: new THREE.Color(0xe6976a),
    skyGlow: new THREE.Color(0xffb56b),
    fogColor: new THREE.Color(0x6e5f6a),
    fogDensity: 0.0095,
    hemiSky: new THREE.Color(0x9bc0eb),
    hemiGround: new THREE.Color(0x2d2a30),
    hemiIntensity: 0.85,
    keyColor: new THREE.Color(0xffbd7a),
    keyIntensity: 1.32,
    rimColor: new THREE.Color(0x6bc9ff),
    rimIntensity: 0.35,
    sunStrength: 0.72,
    moonStrength: 0.08,
    starVisibility: 0.08,
    sunsetStrength: 0.72,
    roomLightScale: 0.36,
    exposure: 1.08,
  },
  {
    hour: 9.0, // Bright Morning
    skyZenith: new THREE.Color(0x2b79c9),
    skyHorizon: new THREE.Color(0xa6d8f7),
    skyGlow: new THREE.Color(0xfff4d6),
    fogColor: new THREE.Color(0x83b4d9),
    fogDensity: 0.0056,
    hemiSky: new THREE.Color(0xd2ecff),
    hemiGround: new THREE.Color(0x364354),
    hemiIntensity: 1.22,
    keyColor: new THREE.Color(0xfff5e0),
    keyIntensity: 1.85,
    rimColor: new THREE.Color(0x7be0ff),
    rimIntensity: 0.38,
    sunStrength: 1.0,
    moonStrength: 0.0,
    starVisibility: 0.0,
    sunsetStrength: 0.0,
    roomLightScale: 0.06,
    exposure: 1.02,
  },
  {
    hour: 13.0, // Bright Midday / Afternoon
    skyZenith: new THREE.Color(0x1f6bc2),
    skyHorizon: new THREE.Color(0x9ed3f5),
    skyGlow: new THREE.Color(0xfff9e6),
    fogColor: new THREE.Color(0x89badc),
    fogDensity: 0.0050,
    hemiSky: new THREE.Color(0xdbf0ff),
    hemiGround: new THREE.Color(0x3b4859),
    hemiIntensity: 1.30,
    keyColor: new THREE.Color(0xfff9eb),
    keyIntensity: 1.98,
    rimColor: new THREE.Color(0x8ee6ff),
    rimIntensity: 0.36,
    sunStrength: 1.0,
    moonStrength: 0.0,
    starVisibility: 0.0,
    sunsetStrength: 0.0,
    roomLightScale: 0.04,
    exposure: 1.00,
  },
  {
    hour: 16.5, // Late Afternoon transitioning to Evening
    skyZenith: new THREE.Color(0x2c66a8),
    skyHorizon: new THREE.Color(0xd9b38c),
    skyGlow: new THREE.Color(0xffca7a),
    fogColor: new THREE.Color(0x857f82),
    fogDensity: 0.0068,
    hemiSky: new THREE.Color(0xc5d8ed),
    hemiGround: new THREE.Color(0x333642),
    hemiIntensity: 1.05,
    keyColor: new THREE.Color(0xffd79e),
    keyIntensity: 1.56,
    rimColor: new THREE.Color(0x64bfff),
    rimIntensity: 0.32,
    sunStrength: 0.92,
    moonStrength: 0.0,
    starVisibility: 0.0,
    sunsetStrength: 0.32,
    roomLightScale: 0.18,
    exposure: 1.05,
  },
  {
    hour: 18.25, // Evening Sunset
    skyZenith: new THREE.Color(0x272b5e),
    skyHorizon: new THREE.Color(0xe36b3f),
    skyGlow: new THREE.Color(0xff9f45),
    fogColor: new THREE.Color(0x52313f),
    fogDensity: 0.0115,
    hemiSky: new THREE.Color(0xbd7d86),
    hemiGround: new THREE.Color(0x1f1924),
    hemiIntensity: 0.72,
    keyColor: new THREE.Color(0xff7d3d),
    keyIntensity: 1.10,
    rimColor: new THREE.Color(0x528fff),
    rimIntensity: 0.34,
    sunStrength: 0.62,
    moonStrength: 0.16,
    starVisibility: 0.18,
    sunsetStrength: 1.0,
    roomLightScale: 0.75,
    exposure: 1.12,
  },
  {
    hour: 19.75, // Dusk -> Nightfall (Lights ON)
    skyZenith: new THREE.Color(0x070c1b),
    skyHorizon: new THREE.Color(0x1c213b),
    skyGlow: new THREE.Color(0x4b2a42),
    fogColor: new THREE.Color(0x0a0e18),
    fogDensity: 0.0195,
    hemiSky: new THREE.Color(0x55719e),
    hemiGround: new THREE.Color(0x0c1018),
    hemiIntensity: 0.28,
    keyColor: new THREE.Color(0x7e9df2),
    keyIntensity: 0.36,
    rimColor: new THREE.Color(0x00d8f0),
    rimIntensity: 0.34,
    sunStrength: 0.04,
    moonStrength: 0.88,
    starVisibility: 0.85,
    sunsetStrength: 0.18,
    roomLightScale: 1.38,
    exposure: 1.17,
  },
  {
    hour: 24.0, // Wrap back to Midnight
    skyZenith: new THREE.Color(0x03060d),
    skyHorizon: new THREE.Color(0x0c1424),
    skyGlow: new THREE.Color(0x16243f),
    fogColor: new THREE.Color(0x06090e),
    fogDensity: 0.021,
    hemiSky: new THREE.Color(0x4b6a99),
    hemiGround: new THREE.Color(0x0b0f17),
    hemiIntensity: 0.22,
    keyColor: new THREE.Color(0x7ca2ff),
    keyIntensity: 0.30,
    rimColor: new THREE.Color(0x00d8f0),
    rimIntensity: 0.34,
    sunStrength: 0.0,
    moonStrength: 1.0,
    starVisibility: 1.0,
    sunsetStrength: 0.0,
    roomLightScale: 1.48,
    exposure: 1.18,
  },
];

/**
 * Computes continuous skybox, directional sun/moon light, fog, and indoor corridor lighting
 * multipliers for any local hour [0..24) plus continuous storm/cloud weather darkness.
 */
export function computeEnvironmentTimeProfile(
  hourFloat: number,
  weatherBlend?: { cloudCover: number; cloudDarkness: number; rainIntensity: number }
): EnvironmentTimeProfile {
  const h = ((hourFloat % 24) + 24) % 24;
  let a = TIME_KEYFRAMES[0];
  let b = TIME_KEYFRAMES[TIME_KEYFRAMES.length - 1];
  for (let i = 0; i < TIME_KEYFRAMES.length - 1; i++) {
    if (h >= TIME_KEYFRAMES[i].hour && h <= TIME_KEYFRAMES[i + 1].hour) {
      a = TIME_KEYFRAMES[i];
      b = TIME_KEYFRAMES[i + 1];
      break;
    }
  }
  const span = Math.max(0.001, b.hour - a.hour);
  const tRaw = THREE.MathUtils.clamp((h - a.hour) / span, 0, 1);
  const t = tRaw * tRaw * (3 - 2 * tRaw);

  // Solar arc: rises east (+X) at 06:00, high overhead at 12:30, sets west (-X) at 19:00
  const dayAngle = ((h - 6.0) / 13.0) * Math.PI;
  const sunX = Math.cos(dayAngle) * 0.78;
  const sunY = Math.sin(dayAngle) * 0.85;
  const sunZ = -0.38;
  const sunDirection = new THREE.Vector3(sunX, sunY, sunZ).normalize();

  const cloudCover = THREE.MathUtils.clamp(weatherBlend?.cloudCover ?? 0.16, 0, 1);
  const cloudDarkness = THREE.MathUtils.clamp(weatherBlend?.cloudDarkness ?? 0, 0, 1);
  const rainIntensity = THREE.MathUtils.clamp(weatherBlend?.rainIntensity ?? 0, 0, 1);

  const skyZenith = a.skyZenith.clone().lerp(b.skyZenith, t);
  const skyHorizon = a.skyHorizon.clone().lerp(b.skyHorizon, t);
  const skyGlow = a.skyGlow.clone().lerp(b.skyGlow, t);
  const fogColor = a.fogColor.clone().lerp(b.fogColor, t);
  const hemiSky = a.hemiSky.clone().lerp(b.hemiSky, t);
  const hemiGround = a.hemiGround.clone().lerp(b.hemiGround, t);
  const keyColor = a.keyColor.clone().lerp(b.keyColor, t);
  const rimColor = a.rimColor.clone().lerp(b.rimColor, t);

  // Darken sky, clouds, and fog during overcast / storm weather
  const stormZenith = new THREE.Color(0x0d131d);
  const stormHorizon = new THREE.Color(0x1f2836);
  const stormFog = new THREE.Color(0x131a26);
  const stormKey = new THREE.Color(0x7d92b0);
  const stormHemi = new THREE.Color(0x52647c);

  const stormMix = cloudDarkness * 0.86;
  skyZenith.lerp(stormZenith, stormMix);
  skyHorizon.lerp(stormHorizon, stormMix * 0.92);
  skyGlow.lerp(stormHorizon, stormMix * 0.78);
  fogColor.lerp(stormFog, stormMix * 0.82);
  hemiSky.lerp(stormHemi, stormMix * 0.72);
  keyColor.lerp(stormKey, stormMix * 0.75);

  const baseRoomScale = THREE.MathUtils.lerp(a.roomLightScale, b.roomLightScale, t);
  const stormRoomBoost = cloudDarkness >= 0.45 ? cloudDarkness * 1.15 : 0;
  const roomLightScale = Math.max(baseRoomScale, stormRoomBoost);
  const lightsOn = h >= 18.25 || h < 6.0 || cloudDarkness >= 0.62;

  const sunStrength =
    THREE.MathUtils.lerp(a.sunStrength, b.sunStrength, t) * (1 - cloudDarkness * 0.88);
  const moonStrength =
    THREE.MathUtils.lerp(a.moonStrength, b.moonStrength, t) * (1 - cloudDarkness * 0.85);
  const starVisibility =
    THREE.MathUtils.lerp(a.starVisibility, b.starVisibility, t) * (1 - cloudCover * 0.94);

  return {
    phase: classifyTimePhase(h),
    skyZenith,
    skyHorizon,
    skyGlow,
    fogColor,
    fogDensity:
      THREE.MathUtils.lerp(a.fogDensity, b.fogDensity, t) + rainIntensity * 0.0085,
    hemiSky,
    hemiGround,
    hemiIntensity:
      THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, t) *
      (1 - cloudDarkness * 0.48),
    keyColor,
    keyIntensity:
      THREE.MathUtils.lerp(a.keyIntensity, b.keyIntensity, t) *
      (1 - cloudDarkness * 0.68),
    rimColor,
    rimIntensity: THREE.MathUtils.lerp(a.rimIntensity, b.rimIntensity, t),
    sunDirection,
    sunStrength,
    moonStrength,
    starVisibility,
    sunsetStrength:
      THREE.MathUtils.lerp(a.sunsetStrength, b.sunsetStrength, t) *
      (1 - cloudDarkness * 0.65),
    cloudCover,
    cloudDarkness,
    roomLightScale,
    lightsOn,
    exposure: THREE.MathUtils.lerp(a.exposure, b.exposure, t) + cloudDarkness * 0.06,
  };
}
