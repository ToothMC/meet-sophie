// lib/maps-fetch.js — Google Maps Platform APIs
// API-Key-basiert (kein OAuth). Tools: Places, Routes, Geocoding, Timezone.
// Kein User-Token noetig — Server-seitiger API Key wie Wetter/Suche.

const API_KEY = () => process.env.GOOGLE_MAPS_API_KEY;

// ── Places: Orte suchen ────────────────────────────────

/**
 * Sucht Orte in der Naehe oder nach Textquery.
 * @param {string} query — z.B. "Restaurant Berlin", "Zahnarzt in der Nähe"
 * @param {object} options
 * @param {string} options.location — lat,lng fuer Nearby Search
 * @param {number} options.radius — Radius in Metern (default 5000)
 * @returns {Array} — normalisierte Orte
 */
export async function searchPlaces(query, { location, radius = 5000, maxResults = 5 } = {}) {
  try {
    const body = {
      textQuery: query,
      maxResultCount: maxResults,
      languageCode: 'de',
    };
    if (location) {
      body.locationBias = {
        circle: { center: { latitude: parseFloat(location.split(',')[0]), longitude: parseFloat(location.split(',')[1]) }, radius },
      };
    }

    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY(),
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.types,places.googleMapsUri,places.currentOpeningHours,places.internationalPhoneNumber',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[maps] Places error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    return (data.places || []).map(p => ({
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      rating: p.rating || null,
      ratingCount: p.userRatingCount || 0,
      phone: p.internationalPhoneNumber || '',
      mapsUrl: p.googleMapsUri || '',
      isOpen: p.currentOpeningHours?.openNow ?? null,
      types: (p.types || []).slice(0, 3),
    }));
  } catch (e) {
    console.warn('[maps] Places error:', e?.message);
    return [];
  }
}

// ── Routes: Fahrtzeit + Entfernung ─────────────────────

/**
 * Berechnet Route zwischen zwei Orten.
 * @param {string} origin — Startadresse oder lat,lng
 * @param {string} destination — Zieladresse oder lat,lng
 * @param {string} mode — DRIVE, WALK, BICYCLE, TRANSIT
 * @returns {{ distance: string, duration: string, summary: string } | null}
 */
export async function getRoute(origin, destination, mode = 'DRIVE') {
  try {
    const body = {
      origin: { address: origin },
      destination: { address: destination },
      travelMode: mode.toUpperCase(),
      languageCode: 'de',
      units: 'METRIC',
    };

    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY(),
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.description,routes.legs.duration,routes.legs.distanceMeters',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`[maps] Routes error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) return null;

    const distKm = route.distanceMeters ? (route.distanceMeters / 1000).toFixed(1) : '?';
    const durSec = parseInt(route.duration?.replace('s', '') || '0');
    const durMin = Math.round(durSec / 60);
    const durStr = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}min` : `${durMin} min`;

    return {
      distance: `${distKm} km`,
      duration: durStr,
      summary: route.description || '',
      mode: mode.toUpperCase(),
    };
  } catch (e) {
    console.warn('[maps] Routes error:', e?.message);
    return null;
  }
}

// ── Geocoding: Adresse → Koordinaten ───────────────────

/**
 * Geocodiert eine Adresse zu Koordinaten.
 * @returns {{ lat: number, lng: number, formattedAddress: string } | null}
 */
export async function geocodeAddress(address) {
  try {
    const params = new URLSearchParams({
      address,
      key: API_KEY(),
      language: 'de',
    });

    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return null;

    return {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      formattedAddress: result.formatted_address,
    };
  } catch (e) {
    console.warn('[maps] Geocoding error:', e?.message);
    return null;
  }
}

// ── Timezone: Zeitzone fuer Koordinaten ────────────────

/**
 * Gibt die Zeitzone fuer einen Ort zurueck.
 * @param {number} lat
 * @param {number} lng
 * @returns {{ timeZoneId: string, timeZoneName: string, offset: number } | null}
 */
export async function getTimezone(lat, lng) {
  try {
    const params = new URLSearchParams({
      location: `${lat},${lng}`,
      timestamp: Math.floor(Date.now() / 1000).toString(),
      key: API_KEY(),
      language: 'de',
    });

    const res = await fetch(`https://maps.googleapis.com/maps/api/timezone/json?${params}`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'OK') return null;

    const offsetHours = (data.rawOffset + data.dstOffset) / 3600;
    return {
      timeZoneId: data.timeZoneId,
      timeZoneName: data.timeZoneName,
      offset: offsetHours,
      offsetStr: `UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`,
    };
  } catch (e) {
    console.warn('[maps] Timezone error:', e?.message);
    return null;
  }
}

// ── Formatierung ───────────────────────────────────────

export function formatPlacesResult(places) {
  if (!places?.length) return 'Keine Orte gefunden.';
  return places.map(p => {
    const parts = [p.name];
    if (p.rating) parts.push(`${p.rating}★ (${p.ratingCount})`);
    if (p.isOpen === true) parts.push('Geöffnet');
    if (p.isOpen === false) parts.push('Geschlossen');
    if (p.address) parts.push(p.address);
    if (p.phone) parts.push(p.phone);
    return `- ${parts.join(' | ')}`;
  }).join('\n');
}

export function formatRouteResult(route) {
  if (!route) return 'Route konnte nicht berechnet werden.';
  const modeLabel = { DRIVE: 'Auto', WALK: 'Zu Fuß', BICYCLE: 'Fahrrad', TRANSIT: 'ÖPNV' };
  return `${modeLabel[route.mode] || route.mode}: ${route.distance}, ${route.duration}${route.summary ? ' (via ' + route.summary + ')' : ''}`;
}

export function formatGeocodeResult(geo) {
  if (!geo) return 'Adresse nicht gefunden.';
  return `${geo.formattedAddress} (${geo.lat}, ${geo.lng})`;
}

export function formatTimezoneResult(tz) {
  if (!tz) return 'Zeitzone nicht gefunden.';
  return `${tz.timeZoneName} (${tz.timeZoneId}, ${tz.offsetStr})`;
}
