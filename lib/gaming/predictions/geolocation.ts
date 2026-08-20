/**
 * Geolocation eligibility — an eligibility/audit mechanism, not
 * anti-GPS-spoofing. Computes the distance between a reported browser
 * position and a Venue's own coordinates, and whether that distance
 * falls within the Venue's configured radius. Raw member coordinates
 * are never persisted; only this computed distance (plus the browser's
 * own reported accuracy and the resulting pass/fail) is ever stored —
 * see predictions.measured_distance_meters/reported_accuracy_meters/
 * geo_eligible (0054).
 */

const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance between two lat/long points, in meters. */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export interface GeoEligibilityResult {
  measuredDistanceMeters: number;
  eligible: boolean;
}

/**
 * Evaluates whether a reported position is within a Venue's radius.
 * Never falls back to any other location source (e.g. IP geolocation)
 * — a caller with no reported position must treat this as ineligible,
 * not attempt an alternate check.
 */
export function evaluateGeoEligibility(
  reportedLatitude: number,
  reportedLongitude: number,
  venueLatitude: number,
  venueLongitude: number,
  venueRadiusMeters: number
): GeoEligibilityResult {
  const measuredDistanceMeters = haversineDistanceMeters(
    reportedLatitude,
    reportedLongitude,
    venueLatitude,
    venueLongitude
  );
  return {
    measuredDistanceMeters,
    eligible: measuredDistanceMeters <= venueRadiusMeters,
  };
}
