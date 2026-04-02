const WEATHER_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_FORECAST_DAYS = 16;

const geocodeCache = new Map();
const forecastCache = new Map();

async function enrichTimelineDaysWithWeather(days, profile = {}) {
  if (!Array.isArray(days) || days.length === 0) {
    return [];
  }

  const location = String(profile.location || "").trim();
  if (!location) {
    return days.map((day) => ({
      ...day,
      weather: null,
    }));
  }

  try {
    const weatherByDate = await getWeatherByDate(location, {
      startDate: days[0].date,
      endDate: days[days.length - 1].date,
    });

    return days.map((day) => ({
      ...day,
      weather: weatherByDate.get(day.date) || null,
    }));
  } catch (_) {
    return days.map((day) => ({
      ...day,
      weather: null,
    }));
  }
}

async function searchLocationSuggestions(query) {
  const location = String(query || "").trim();
  if (location.length < 3) {
    return [];
  }

  if (getMapboxAccessToken()) {
    return searchMapboxSuggestions(location);
  }

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "5");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Weather geocoding failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results
    .map((result) => buildLocationLabel(result))
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function getWeatherByDate(location, range) {
  const geocode = await geocodeLocation(location);
  if (!geocode) {
    return new Map();
  }

  const forecast = await fetchForecast(geocode, range);
  const daily = forecast?.daily;
  if (!daily || !Array.isArray(daily.time)) {
    return new Map();
  }

  const weatherByDate = new Map();
  daily.time.forEach((date, index) => {
    const code = Number(daily.weather_code?.[index]);
    const descriptor = describeWeatherCode(code);
    weatherByDate.set(date, {
      condition: descriptor.condition,
      icon: descriptor.icon,
      tempFHigh: normalizeTemperature(daily.temperature_2m_max?.[index]),
      tempFLow: normalizeTemperature(daily.temperature_2m_min?.[index]),
      precipitationChance: normalizePercent(daily.precipitation_probability_max?.[index]),
    });
  });

  return weatherByDate;
}

async function geocodeLocation(location) {
  const cacheKey = location.toLowerCase();
  const cached = readCache(geocodeCache, cacheKey);
  if (cached) {
    return cached;
  }

  if (getMapboxAccessToken()) {
    const geocode = await geocodeWithMapbox(location);
    if (geocode) {
      writeCache(geocodeCache, cacheKey, geocode);
      return geocode;
    }
  }

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Weather geocoding failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const first = Array.isArray(payload?.results) ? payload.results[0] : null;
  if (!first) {
    return null;
  }

  const normalized = {
    latitude: Number(first.latitude),
    longitude: Number(first.longitude),
    timezone: String(first.timezone || "auto"),
    label: buildLocationLabel(first),
  };
  writeCache(geocodeCache, cacheKey, normalized);
  return normalized;
}

async function searchMapboxSuggestions(location) {
  const accessToken = getMapboxAccessToken();
  if (!accessToken) {
    return [];
  }
  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json`
  );
  url.searchParams.set("autocomplete", "true");
  url.searchParams.set("limit", "5");
  url.searchParams.set("types", "address,place,postcode,locality,neighborhood");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Mapbox suggestions failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const features = Array.isArray(payload?.features) ? payload.features : [];
  return features
    .map((feature) => String(feature?.place_name || "").trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function geocodeWithMapbox(location) {
  const accessToken = getMapboxAccessToken();
  if (!accessToken) {
    return null;
  }
  const url = new URL(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json`
  );
  url.searchParams.set("autocomplete", "true");
  url.searchParams.set("limit", "1");
  url.searchParams.set("types", "address,place,postcode,locality,neighborhood");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Mapbox geocoding failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const feature = Array.isArray(payload?.features) ? payload.features[0] : null;
  const center = Array.isArray(feature?.center) ? feature.center : null;
  if (!feature || !center || center.length < 2) {
    return null;
  }

  return {
    latitude: Number(center[1]),
    longitude: Number(center[0]),
    timezone: "auto",
    label: String(feature.place_name || "").trim(),
  };
}

async function fetchForecast(geocode, range) {
  const forecastRange = clampForecastRange(range);
  const cacheKey = [
    geocode.latitude,
    geocode.longitude,
    forecastRange.startDate,
    forecastRange.endDate,
  ].join(":");
  const cached = readCache(forecastCache, cacheKey);
  if (cached) {
    return cached;
  }

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(geocode.latitude));
  url.searchParams.set("longitude", String(geocode.longitude));
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  );
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("timezone", geocode.timezone || "auto");
  url.searchParams.set("start_date", forecastRange.startDate);
  url.searchParams.set("end_date", forecastRange.endDate);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Weather forecast failed with status ${response.status}.`);
  }

  const payload = await response.json();
  writeCache(forecastCache, cacheKey, payload);
  return payload;
}

function describeWeatherCode(code) {
  if (code === 0) {
    return { icon: "sunny", condition: "Clear" };
  }
  if (code === 1 || code === 2) {
    return { icon: "partly_cloudy_day", condition: "Partly cloudy" };
  }
  if (code === 3) {
    return { icon: "cloud", condition: "Cloudy" };
  }
  if (code === 45 || code === 48) {
    return { icon: "foggy", condition: "Fog" };
  }
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return { icon: "rainy", condition: "Rain" };
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
    return { icon: "cloudy_snowing", condition: "Snow" };
  }
  if (code >= 95 && code <= 99) {
    return { icon: "thunderstorm", condition: "Storms" };
  }
  return { icon: "cloud", condition: "Forecast" };
}

function buildLocationLabel(result) {
  const parts = [
    result.name,
    result.admin1,
    result.country_code,
  ].filter(Boolean);
  return parts.join(", ");
}

function normalizeTemperature(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function normalizePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function readCache(cache, key) {
  const record = cache.get(key);
  if (!record) {
    return null;
  }
  if (Date.now() > record.expiresAt) {
    cache.delete(key);
    return null;
  }
  return record.value;
}

function writeCache(cache, key, value) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + WEATHER_CACHE_TTL_MS,
  });
}

function getMapboxAccessToken() {
  return String(process.env.MAPBOX_ACCESS_TOKEN || "").trim();
}

function clampForecastRange(range) {
  const start = new Date(`${range.startDate}T12:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + (MAX_FORECAST_DAYS - 1));
  const requestedEnd = new Date(`${range.endDate}T12:00:00`);
  if (requestedEnd < end) {
    return {
      startDate: range.startDate,
      endDate: range.endDate,
    };
  }
  return {
    startDate: range.startDate,
    endDate: end.toISOString().split("T")[0],
  };
}

module.exports = {
  enrichTimelineDaysWithWeather,
  searchLocationSuggestions,
};
