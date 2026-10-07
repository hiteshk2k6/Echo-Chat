// Unit tests for the distance formulas used to decide whether a user can see a message.

import { isWithinRadiusMeters } from "../socket_server/distance_check";
import { Location } from "../types";

// One degree of latitude in meters, using the same Earth radius as distance_check.ts
const METERS_PER_DEG_LAT = (Math.PI / 180) * 6371000; // ~111,195 m

const loc = (lat: number, lon: number): Location => new Location({ lat, lon, geohash: "" });

// Returns a point that is `meters` north of `p`
const north = (p: Location, meters: number): Location => loc(p.lat + meters / METERS_PER_DEG_LAT, p.lon);

// Returns a point that is `meters` east of `p` (along the same latitude)
const east = (p: Location, meters: number): Location => {
    const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180);
    let lon = p.lon + meters / metersPerDegLon;
    if (lon > 180) lon -= 360;
    return loc(p.lat, lon);
};

const UF_MARSTON = loc(29.6481, -82.3437);

describe("isWithinRadiusMeters", () => {
    describe("small radii (equirectangular approximation)", () => {
        test("same point is always within radius", () => {
            expect(isWithinRadiusMeters(UF_MARSTON, UF_MARSTON, 0)).toBe(true);
            expect(isWithinRadiusMeters(UF_MARSTON, UF_MARSTON, 100)).toBe(true);
        });

        test.each([1, 10, 50, 99])("point %i m north is inside a 100 m radius", (m) => {
            expect(isWithinRadiusMeters(UF_MARSTON, north(UF_MARSTON, m), 100)).toBe(true);
        });

        test.each([101, 150, 500, 1400])("point %i m north is outside a 100 m radius", (m) => {
            expect(isWithinRadiusMeters(UF_MARSTON, north(UF_MARSTON, m), 100)).toBe(false);
        });

        test.each([10, 50, 99])("point %i m east is inside a 100 m radius", (m) => {
            expect(isWithinRadiusMeters(UF_MARSTON, east(UF_MARSTON, m), 100)).toBe(true);
        });

        test.each([101, 250])("point %i m east is outside a 100 m radius", (m) => {
            expect(isWithinRadiusMeters(UF_MARSTON, east(UF_MARSTON, m), 100)).toBe(false);
        });

        test("diagonal: 60 m north + 60 m east (~85 m) is inside, 75 m + 75 m (~106 m) is outside", () => {
            expect(isWithinRadiusMeters(UF_MARSTON, east(north(UF_MARSTON, 60), 60), 100)).toBe(true);
            expect(isWithinRadiusMeters(UF_MARSTON, east(north(UF_MARSTON, 75), 75), 100)).toBe(false);
        });

        test("result is symmetric (order of points does not matter)", () => {
            const other = east(north(UF_MARSTON, 40), 30);
            expect(isWithinRadiusMeters(UF_MARSTON, other, 100)).toBe(isWithinRadiusMeters(other, UF_MARSTON, 100));
        });

        test("radius of 1 m distinguishes 0.5 m from 2 m", () => {
            expect(isWithinRadiusMeters(UF_MARSTON, north(UF_MARSTON, 0.5), 1)).toBe(true);
            expect(isWithinRadiusMeters(UF_MARSTON, north(UF_MARSTON, 2), 1)).toBe(false);
        });
    });

    describe("large radii (haversine formula)", () => {
        // Real-world distances: Gainesville -> Orlando ~ 175 km, Gainesville -> Miami ~ 500 km
        const GAINESVILLE = loc(29.6516, -82.3248);
        const ORLANDO = loc(28.5384, -81.3789);
        const MIAMI = loc(25.7617, -80.1918);

        test("Orlando is within 200 km of Gainesville but not within 150 km", () => {
            expect(isWithinRadiusMeters(GAINESVILLE, ORLANDO, 200_000)).toBe(true);
            expect(isWithinRadiusMeters(GAINESVILLE, ORLANDO, 150_000)).toBe(false);
        });

        test("Miami is within 500 km of Gainesville but not within 450 km", () => {
            expect(isWithinRadiusMeters(GAINESVILLE, MIAMI, 500_000)).toBe(true);
            expect(isWithinRadiusMeters(GAINESVILLE, MIAMI, 450_000)).toBe(false);
        });

        test("points 1.9 km and 2.1 km away are separated by a 2 km radius", () => {
            expect(isWithinRadiusMeters(UF_MARSTON, north(UF_MARSTON, 1900), 2000)).toBe(true);
            expect(isWithinRadiusMeters(UF_MARSTON, north(UF_MARSTON, 2100), 2000)).toBe(false);
        });

        test("antipodal points are only within a radius of half the Earth's circumference", () => {
            const a = loc(10, 20);
            const b = loc(-10, -160);
            expect(isWithinRadiusMeters(a, b, 20_000_000)).toBe(false);
            expect(isWithinRadiusMeters(a, b, 20_100_000)).toBe(true);
        });
    });

    describe("both formulas agree around the 1.5 km switch-over", () => {
        test.each([1400, 1499, 1500, 1501, 1600])("point 1450 m away vs radius %i m", (r) => {
            const p = north(UF_MARSTON, 1450);
            expect(isWithinRadiusMeters(UF_MARSTON, p, r)).toBe(1450 <= r);
        });
    });

    describe("obscure coordinates", () => {
        test("crossing the antimeridian (180° / -180°) near the equator", () => {
            const westSide = loc(0, 179.9997); // ~33 m west of the antimeridian
            const eastSide = loc(0, -179.9997); // ~33 m east of the antimeridian
            expect(isWithinRadiusMeters(westSide, eastSide, 100)).toBe(true);
            expect(isWithinRadiusMeters(westSide, eastSide, 50)).toBe(false);
            expect(isWithinRadiusMeters(westSide, eastSide, 2000)).toBe(true); // haversine path
        });

        test("crossing the prime meridian and the equator", () => {
            const p = loc(-0.0002, -0.0002);
            const q = loc(0.0002, 0.0002); // ~63 m away
            expect(isWithinRadiusMeters(p, q, 100)).toBe(true);
            expect(isWithinRadiusMeters(p, q, 50)).toBe(false);
        });

        test("near the North Pole, a large change in longitude is a small distance", () => {
            const a = loc(89.9999, 0);
            const b = loc(89.9999, 90); // both ~11 m from the pole, ~16 m apart
            expect(isWithinRadiusMeters(a, b, 100)).toBe(true);
            expect(isWithinRadiusMeters(a, b, 10)).toBe(false);
        });

        // KNOWN LIMITATION: the equirectangular approximation measures along the circle of latitude
        // (~140 m here) instead of through the pole (~89 m), so these users can't see each other.
        // This is marked as failing so it documents the bug; flip it to `test` once it's fixed.
        test.failing("near the South Pole, points on opposite sides of the pole", () => {
            const a = loc(-89.9996, 0);
            const b = loc(-89.9996, 180); // ~89 m apart through the pole
            expect(isWithinRadiusMeters(a, b, 100)).toBe(true);
            expect(isWithinRadiusMeters(a, b, 80)).toBe(false);
        });

        test("high latitude: east-west degrees shrink (Svalbard, 78°N)", () => {
            const svalbard = loc(78.2232, 15.6267);
            expect(isWithinRadiusMeters(svalbard, east(svalbard, 90), 100)).toBe(true);
            expect(isWithinRadiusMeters(svalbard, east(svalbard, 110), 100)).toBe(false);
        });
    });
});
