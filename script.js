"use strict";
/* Weather App — plain HTML, CSS and JavaScript.
   Data: Open-Meteo (free, no API key needed, so there is no secret to protect). */

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const DEFAULT_CITY = "Jaipur";
const STORAGE_RECENT = "weatherRecentPlaces";
const STORAGE_UNIT = "weatherUnit";

/* WMO weather code -> [label, day icon, night icon, sky theme] */
const WEATHER_CODES = {
    0: ["Clear sky", "☀️", "🌙", "clear"],
    1: ["Mainly clear", "🌤️", "🌙", "clear"],
    2: ["Partly cloudy", "⛅", "☁️", "cloudy"],
    3: ["Overcast", "☁️", "☁️", "cloudy"],
    45: ["Fog", "🌫️", "🌫️", "fog"],
    48: ["Rime fog", "🌫️", "🌫️", "fog"],
    51: ["Light drizzle", "🌦️", "🌧️", "rain"],
    53: ["Drizzle", "🌦️", "🌧️", "rain"],
    55: ["Dense drizzle", "🌧️", "🌧️", "rain"],
    56: ["Freezing drizzle", "🌧️", "🌧️", "rain"],
    57: ["Heavy freezing drizzle", "🌧️", "🌧️", "rain"],
    61: ["Light rain", "🌦️", "🌧️", "rain"],
    63: ["Rain", "🌧️", "🌧️", "rain"],
    65: ["Heavy rain", "🌧️", "🌧️", "rain"],
    66: ["Freezing rain", "🌧️", "🌧️", "rain"],
    67: ["Heavy freezing rain", "🌧️", "🌧️", "rain"],
    71: ["Light snow", "🌨️", "🌨️", "snow"],
    73: ["Snow", "🌨️", "🌨️", "snow"],
    75: ["Heavy snow", "❄️", "❄️", "snow"],
    77: ["Snow grains", "🌨️", "🌨️", "snow"],
    80: ["Light rain showers", "🌦️", "🌧️", "rain"],
    81: ["Rain showers", "🌧️", "🌧️", "rain"],
    82: ["Violent rain showers", "🌧️", "🌧️", "rain"],
    85: ["Light snow showers", "🌨️", "🌨️", "snow"],
    86: ["Heavy snow showers", "❄️", "❄️", "snow"],
    95: ["Thunderstorm", "⛈️", "⛈️", "storm"],
    96: ["Thunderstorm with hail", "⛈️", "⛈️", "storm"],
    99: ["Severe thunderstorm with hail", "⛈️", "⛈️", "storm"]
};

function describe(code, isDay) {
    const entry = WEATHER_CODES[code] || ["Unknown", "🌡️", "🌡️", "cloudy"];
    return { label: entry[0], icon: isDay ? entry[1] : entry[2], sky: entry[3] };
}

class UserError extends Error {}

const $ = function (id) { return document.getElementById(id); };

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/* ---------- state ---------- */
let unit = loadUnit();
let state = null;      // { place, data } of the weather being shown
let requestId = 0;     // ignores answers that arrive after a newer search

/* ---------- storage (always wrapped: it can be blocked) ---------- */
function loadUnit() {
    try { return localStorage.getItem(STORAGE_UNIT) === "F" ? "F" : "C"; } catch (e) { return "C"; }
}
function saveUnit() {
    try { localStorage.setItem(STORAGE_UNIT, unit); } catch (e) { /* ignore */ }
}
function validPlace(p) {
    return p && typeof p.label === "string" && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}
function loadRecent() {
    try {
        const list = JSON.parse(localStorage.getItem(STORAGE_RECENT));
        return Array.isArray(list) ? list.filter(validPlace).slice(0, 5) : [];
    } catch (e) { return []; }
}
function saveRecent(place) {
    if (place.label === "My location") return;
    const list = loadRecent().filter(function (p) { return p.label !== place.label; });
    list.unshift({ label: place.label, lat: place.lat, lon: place.lon });
    try { localStorage.setItem(STORAGE_RECENT, JSON.stringify(list.slice(0, 5))); } catch (e) { /* ignore */ }
}

/* ---------- formatting ---------- */
function deg(celsius) {
    const value = unit === "F" ? celsius * 9 / 5 + 32 : celsius;
    return Math.round(value) + "°";
}
function to12h(hhmm) {
    const parts = hhmm.split(":");
    const h = Number(parts[0]);
    return (h % 12 || 12) + ":" + parts[1] + " " + (h >= 12 ? "PM" : "AM");
}
function hourLabel(iso) {
    const h = Number(iso.slice(11, 13));
    return (h % 12 || 12) + " " + (h >= 12 ? "PM" : "AM");
}
function dayLabel(dateStr, index) {
    if (index === 0) return "Today";
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
}
function compass(degrees) {
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return names[Math.round(degrees / 45) % 8];
}
function percent(value) {
    return (value === null || value === undefined ? 0 : Math.round(value)) + "%";
}

/* ---------- network ---------- */
async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 12000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("HTTP " + response.status);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function toPlace(r) {
    const label = [r.name, r.admin1, r.country]
        .filter(Boolean)
        .filter(function (v, i, all) { return all.indexOf(v) === i; })
        .join(", ");
    return { label: label, lat: r.latitude, lon: r.longitude };
}

async function findPlaces(query) {
    const parts = query.split(",");
    const name = parts[0].trim();
    const hint = parts.slice(1).join(" ").trim().toLowerCase();
    if (name.length < 2) throw new UserError("Please enter at least 2 letters of a city name.");

    const data = await fetchJson(GEO_URL + "?name=" + encodeURIComponent(name) + "&count=10&language=en&format=json");
    let results = Array.isArray(data.results) ? data.results : [];

    if (hint) {
        const narrowed = results.filter(function (r) {
            return (r.country_code || "").toLowerCase() === hint ||
                (r.country || "").toLowerCase().startsWith(hint) ||
                (r.admin1 || "").toLowerCase().startsWith(hint);
        });
        if (narrowed.length) results = narrowed;
    }
    return results.slice(0, 5).map(toPlace);
}

async function fetchForecast(place) {
    const url = FORECAST_URL +
        "?latitude=" + place.lat + "&longitude=" + place.lon +
        "&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m" +
        "&hourly=temperature_2m,weather_code,precipitation_probability,is_day" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset" +
        "&timezone=auto&forecast_days=7";
    const data = await fetchJson(url);
    if (!data || !data.current || !data.hourly || !data.daily) throw new Error("Unexpected response");
    return data;
}

/* ---------- messages ---------- */
function setStatus(text, isError) {
    const status = $("status");
    status.textContent = text;
    status.classList.toggle("error", !!isError);
}

function errorMessage(err) {
    if (err instanceof UserError) return err.message;
    if (err && err.name === "AbortError") return "The weather service took too long to respond. Please try again.";
    if (err instanceof TypeError) return "Network error. Check your internet connection.";
    if (err && /HTTP 429/.test(err.message)) return "Too many requests. Please wait a moment and try again.";
    return "The weather service is unavailable right now. Please try again.";
}

function setBusy(busy) {
    $("searchBtn").disabled = busy;
    $("locBtn").disabled = busy;
    document.body.setAttribute("aria-busy", String(busy));
}

/* ---------- rendering ---------- */
function render(place, data) {
    const cur = data.current;
    const daily = data.daily;
    const isDay = cur.is_day === 1;
    const info = describe(cur.weather_code, isDay);

    document.body.dataset.sky = isDay ? info.sky : "night";
    $("placeName").textContent = place.label;
    $("updated").textContent = "Updated " + to12h(cur.time.slice(11, 16)) + " (local time)";
    $("temp").textContent = deg(cur.temperature_2m) + unit;
    $("cond").textContent = info.label;
    $("hilo").textContent = "High " + deg(daily.temperature_2m_max[0]) + "  ·  Low " + deg(daily.temperature_2m_min[0]);
    $("heroIcon").textContent = info.icon;

    const items = [
        ["Feels like", deg(cur.apparent_temperature)],
        ["Humidity", Math.round(cur.relative_humidity_2m) + "%"],
        ["Wind", Math.round(cur.wind_speed_10m) + " km/h " + compass(cur.wind_direction_10m)],
        ["Pressure", Math.round(cur.surface_pressure) + " hPa"],
        ["Precipitation", cur.precipitation + " mm"],
        ["Rain chance", percent(daily.precipitation_probability_max[0])],
        ["Sunrise", to12h(daily.sunrise[0].slice(11, 16))],
        ["Sunset", to12h(daily.sunset[0].slice(11, 16))]
    ];
    const details = $("details");
    details.replaceChildren();
    items.forEach(function (item) {
        const box = el("div", "detail");
        box.append(el("div", "k", item[0]), el("div", "v", item[1]));
        details.append(box);
    });

    const hourly = $("hourly");
    hourly.replaceChildren();
    const nowHour = cur.time.slice(0, 13) + ":00";
    let start = data.hourly.time.findIndex(function (t) { return t >= nowHour; });
    if (start < 0) start = 0;
    for (let i = start; i < Math.min(start + 24, data.hourly.time.length); i++) {
        const h = describe(data.hourly.weather_code[i], data.hourly.is_day[i] === 1);
        const rain = data.hourly.precipitation_probability[i];
        const box = el("div", "hour");
        box.append(
            el("div", "t", i === start ? "Now" : hourLabel(data.hourly.time[i])),
            el("div", "i", h.icon),
            el("div", "d", deg(data.hourly.temperature_2m[i])),
            el("div", "r", rain > 0 ? "💧" + Math.round(rain) + "%" : "")
        );
        hourly.append(box);
    }

    const list = $("daily");
    list.replaceChildren();
    daily.time.forEach(function (date, i) {
        const d = describe(daily.weather_code[i], true);
        const rain = daily.precipitation_probability_max[i];
        const row = el("li", "day");
        const range = el("div", "range", deg(daily.temperature_2m_max[i]) + " ");
        range.append(el("span", "", "/ " + deg(daily.temperature_2m_min[i])));
        row.append(
            el("div", "n", dayLabel(date, i)),
            el("div", "i", d.icon),
            el("div", "r", rain > 0 ? "💧 " + Math.round(rain) + "%  " + d.label : d.label),
            range
        );
        list.append(row);
    });

    $("weather").hidden = false;
    $("unitBtn").textContent = unit === "C" ? "Show °F" : "Show °C";
}

function renderChips(container, labelText, places, onPick) {
    container.replaceChildren();
    if (!places.length) { container.hidden = true; return; }
    container.append(el("span", "label", labelText));
    places.forEach(function (place) {
        const chip = el("button", "chip", place.label);
        chip.type = "button";
        chip.addEventListener("click", function () { onPick(place); });
        container.append(chip);
    });
    container.hidden = false;
}

function renderRecent() {
    renderChips($("recent"), "Recent:", loadRecent(), function (place) { loadPlace(place, []); });
}
function renderMatches(alternatives) {
    renderChips($("matches"), "Other matches:", alternatives, function (place) { loadPlace(place, []); });
}

/* ---------- actions ---------- */
async function run(task) {
    const id = ++requestId;
    setBusy(true);
    try {
        await task(id);
    } catch (err) {
        if (id === requestId) setStatus(errorMessage(err), true);
        console.error("Weather error:", err);
    } finally {
        if (id === requestId) setBusy(false);
    }
}

async function showPlace(place, alternatives, id) {
    setStatus("Loading weather…");
    const data = await fetchForecast(place);
    if (id !== requestId) return;
    state = { place: place, data: data };
    render(place, data);
    saveRecent(place);
    renderRecent();
    renderMatches(alternatives);
    setStatus("");
}

function searchCity(query) {
    return run(async function (id) {
        setStatus("Searching…");
        const places = await findPlaces(query);
        if (id !== requestId) return;
        if (!places.length) throw new UserError('City not found. Check the spelling or try "City, Country".');
        await showPlace(places[0], places.slice(1), id);
    });
}

function loadPlace(place, alternatives) {
    return run(function (id) { return showPlace(place, alternatives, id); });
}

function useMyLocation() {
    if (!navigator.geolocation) {
        setStatus("Your browser does not support location. Please search for a city.", true);
        return;
    }
    setStatus("Getting your location…");
    navigator.geolocation.getCurrentPosition(
        function (pos) {
            loadPlace({
                label: "My location",
                lat: Number(pos.coords.latitude.toFixed(4)),
                lon: Number(pos.coords.longitude.toFixed(4))
            }, []);
        },
        function (err) {
            setStatus(err && err.code === 1
                ? "Location permission was denied. Please search for a city."
                : "Could not get your location. Please search for a city.", true);
        },
        { timeout: 10000, maximumAge: 600000 }
    );
}

/* ---------- events ---------- */
$("searchForm").addEventListener("submit", function (event) {
    event.preventDefault();
    const query = $("cityInput").value.replace(/\s+/g, " ").trim();
    if (!query) {
        setStatus("Please enter a city name.", true);
        return;
    }
    searchCity(query);
});

$("locBtn").addEventListener("click", useMyLocation);

$("unitBtn").addEventListener("click", function () {
    unit = unit === "C" ? "F" : "C";
    saveUnit();
    if (state) render(state.place, state.data);
    else $("unitBtn").textContent = unit === "C" ? "Show °F" : "Show °C";
});

/* ---------- start ---------- */
$("unitBtn").textContent = unit === "C" ? "Show °F" : "Show °C";
renderRecent();
const recent = loadRecent();
if (recent.length) loadPlace(recent[0], []);
else searchCity(DEFAULT_CITY);
