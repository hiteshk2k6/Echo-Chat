// Tests for the geohash region map that decides which active users are "in view" of a location.

import { getActiveUsersInView, initRegions, removeActiveUser, setActiveUserRegion, viewDistanceMeters } from "../socket_server/regions";
import { ActiveUser, Location } from "../types";

const METERS_PER_DEG_LAT = (Math.PI / 180) * 6371000;

// Location constructor computes the geohash when it isn't provided
const loc = (lat: number, lon: number): Location => new Location({ lat, lon } as any);
const north = (p: Location, meters: number): Location => loc(p.lat + meters / METERS_PER_DEG_LAT, p.lon);

const makeUser = (uid: string): ActiveUser => ({
    socket: {} as any, // regions.ts never touches the socket
    uid,
    location: new Location({ lat: 0, lon: 0, geohash: "" }),
    profile: { displayName: uid, profilePicture: 0 },
});

// Mirrors update_location.ts: move the user and update the region map
const moveUser = (user: ActiveUser, to: Location) => {
    const oldLocation = user.location.geohash !== "" ? user.location : undefined;
    setActiveUserRegion(user, oldLocation, to);
    user.location = to;
};

const uidsInView = (p: Location): string[] => [...new Set([...getActiveUsersInView(p)].map((u) => u.uid))].sort();

const CENTER = loc(29.6436, -82.3549); // UF Reitz Union

beforeEach(() => {
    initRegions();
});

describe("getActiveUsersInView", () => {
    test("view distance is 100 m", () => {
        expect(viewDistanceMeters).toBe(100);
    });

    test("returns nothing when no users are active", () => {
        expect(uidsInView(CENTER)).toEqual([]);
    });

    test("returns a user standing at the exact location", () => {
        const alice = makeUser("alice");
        moveUser(alice, CENTER);
        expect(uidsInView(CENTER)).toEqual(["alice"]);
    });

    test("includes users within 100 m and excludes users farther away", () => {
        const users: [string, number][] = [
            ["at_10m", 10],
            ["at_50m", 50],
            ["at_95m", 95],
            ["at_105m", 105],
            ["at_300m", 300],
            ["at_5km", 5000],
        ];
        for (const [uid, meters] of users) moveUser(makeUser(uid), north(CENTER, meters));

        expect(uidsInView(CENTER)).toEqual(["at_10m", "at_50m", "at_95m"]);
    });

    test("users in a different city are never returned", () => {
        moveUser(makeUser("orlando"), loc(28.5384, -81.3789));
        moveUser(makeUser("tokyo"), loc(35.6762, 139.6503));
        moveUser(makeUser("local"), north(CENTER, 20));
        expect(uidsInView(CENTER)).toEqual(["local"]);
    });

    test("a user moving out of range is no longer returned", () => {
        const bob = makeUser("bob");
        moveUser(bob, north(CENTER, 30));
        expect(uidsInView(CENTER)).toEqual(["bob"]);

        moveUser(bob, north(CENTER, 2000));
        expect(uidsInView(CENTER)).toEqual([]);
        expect(uidsInView(bob.location)).toEqual(["bob"]);
    });

    test("a user moving into range is returned", () => {
        const bob = makeUser("bob");
        moveUser(bob, north(CENTER, 1000));
        expect(uidsInView(CENTER)).toEqual([]);

        moveUser(bob, north(CENTER, 40));
        expect(uidsInView(CENTER)).toEqual(["bob"]);
    });

    test("a removed (disconnected) user is no longer returned", () => {
        const alice = makeUser("alice");
        const bob = makeUser("bob");
        moveUser(alice, CENTER);
        moveUser(bob, north(CENTER, 25));

        removeActiveUser(bob);
        expect(uidsInView(CENTER)).toEqual(["alice"]);
    });

    test("removing a user who never sent a location does not throw", () => {
        expect(() => removeActiveUser(makeUser("ghost"))).not.toThrow();
    });

    test("users straddling a geohash cell boundary still see each other", () => {
        // Points just either side of the equator / prime meridian fall in completely different geohash cells
        const a = loc(0.0001, 0.0001);
        const b = loc(-0.0001, -0.0001); // ~31 m away
        expect(a.geohash[0]).not.toBe(b.geohash[0]);

        moveUser(makeUser("a"), a);
        moveUser(makeUser("b"), b);
        expect(uidsInView(a)).toEqual(["a", "b"]);
        expect(uidsInView(b)).toEqual(["a", "b"]);
    });

    test("users on either side of the antimeridian see each other", () => {
        const west = loc(0, 179.9997);
        const east = loc(0, -179.9997); // ~67 m away
        moveUser(makeUser("west"), west);
        moveUser(makeUser("east"), east);
        expect(uidsInView(west)).toEqual(["east", "west"]);
    });

    test("many users scattered in a ring: only the inner ones are in view", () => {
        // 36 users at 80 m and 36 users at 120 m, spread around the compass
        for (let i = 0; i < 36; i++) {
            const angle = (i * 10 * Math.PI) / 180;
            for (const r of [80, 120]) {
                const dLat = (r * Math.cos(angle)) / METERS_PER_DEG_LAT;
                const dLon = (r * Math.sin(angle)) / (METERS_PER_DEG_LAT * Math.cos((CENTER.lat * Math.PI) / 180));
                moveUser(makeUser(`r${r}_${i}`), loc(CENTER.lat + dLat, CENTER.lon + dLon));
            }
        }
        const inView = uidsInView(CENTER);
        expect(inView).toHaveLength(36);
        expect(inView.every((uid) => uid.startsWith("r80_"))).toBe(true);
    });
});
