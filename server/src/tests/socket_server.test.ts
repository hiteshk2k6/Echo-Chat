// End-to-end tests: real socket.io clients connect to the real socket server and
// we check which clients actually receive a message based on their location.
// Firebase is mocked so these tests run without credentials.

import { AddressInfo } from "net";
import { io as ioc, Socket } from "socket.io-client";

import { startSocketServer } from "../socket_server/socket_server";

// The auth token is used directly as the uid, and every uid has a profile
jest.mock("../firebase_methods", () => ({
    ensureUserAuthorized: async (token: any) => (token ? [token, undefined] : [undefined, "User not authenticated!"]),
    getUserProfile: async (uid: string) => ({ displayName: uid, profilePicture: 0 }),
}));

jest.setTimeout(15000);

const METERS_PER_DEG_LAT = (Math.PI / 180) * 6371000;
const CENTER = { lat: 29.6436, lon: -82.3549 }; // UF Reitz Union
const north = (p: { lat: number; lon: number }, meters: number) => ({ lat: p.lat + meters / METERS_PER_DEG_LAT, lon: p.lon });

// Time to wait before deciding that a client did NOT receive a message
const NO_MESSAGE_WAIT_MS = 300;

let server: ReturnType<typeof startSocketServer>;
let url: string;
let clients: Socket[] = [];

beforeAll((done) => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});

    process.env.socket_port = "0"; // let the OS pick a free port
    server = startSocketServer();
    server.httpServer.once("listening", () => {
        url = `http://localhost:${(server.httpServer.address() as AddressInfo).port}`;
        done();
    });
});

afterEach(() => {
    clients.forEach((c) => c.disconnect());
    clients = [];
});

afterAll((done) => {
    server.socketServer.close(() => done());
});

// Connect a client as `uid`. The server registers its event handlers only after the
// (async) auth + profile lookup, so retry a ping until the server acknowledges it.
const connect = async (uid: string): Promise<Socket> => {
    const socket = ioc(url, { auth: { token: uid }, transports: ["websocket"], forceNew: true, reconnection: false });
    clients.push(socket);
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            if ((await socket.timeout(100).emitWithAck("ping")) === "pong") return socket;
        } catch { /* not ready yet */ }
    }
    throw new Error(`Client ${uid} never became ready`);
};

// Connect a client and place it at a location
const connectAt = async (uid: string, location: { lat: number; lon: number }): Promise<Socket> => {
    const socket = await connect(uid);
    expect(await socket.emitWithAck("updateLocation", location)).toBe("success");
    return socket;
};

const nextMessage = (socket: Socket): Promise<any> => new Promise((resolve) => socket.once("message", resolve));

// Resolves true if a message arrives within NO_MESSAGE_WAIT_MS, false otherwise
const receivesMessage = (socket: Socket): Promise<boolean> =>
    new Promise((resolve) => {
        const timer = setTimeout(() => { socket.off("message", onMessage); resolve(false); }, NO_MESSAGE_WAIT_MS);
        const onMessage = () => { clearTimeout(timer); resolve(true); };
        socket.once("message", onMessage);
    });

const makeMessage = (author: string, text: string, location?: { lat: number; lon: number }) => ({
    id: `${author}-${Date.now()}`,
    author,
    content: { text },
    reactions: {},
    ...(location ? { location } : {}),
});

describe("socket server", () => {
    test("responds to ping with pong", async () => {
        const alice = await connect("alice");
        expect(await alice.emitWithAck("ping")).toBe("pong");
    });

    test("disconnects clients without an auth token", async () => {
        const anon = ioc(url, { transports: ["websocket"], forceNew: true, reconnection: false });
        clients.push(anon);
        await new Promise<void>((resolve) => anon.on("disconnect", () => resolve()));
        expect(anon.connected).toBe(false);
    });

    test("rejects messages with an invalid location", async () => {
        const alice = await connectAt("alice", CENTER);
        expect(await alice.emitWithAck("sendMessage", makeMessage("alice", "hi", { lat: 91, lon: 0 }))).toBe("invalid_location");
        expect(await alice.emitWithAck("sendMessage", makeMessage("alice", "hi", { lat: 0, lon: -181 }))).toBe("invalid_location");
    });
});

describe("message delivery by distance", () => {
    test("a client within 100 m receives the message, with the original text", async () => {
        const alice = await connectAt("alice", CENTER);
        const bob = await connectAt("bob", north(CENTER, 50));

        const received = nextMessage(bob);
        expect(await alice.emitWithAck("sendMessage", makeMessage("alice", "hello bob"))).toBe("success");

        const msg = await received;
        expect(msg.author).toBe("alice");
        expect(msg.content.text).toBe("hello bob");
        expect(typeof msg.timestamp).toBe("number");
    });

    test("only clients inside the radius receive the message", async () => {
        const alice = await connectAt("alice", CENTER);
        const near = await connectAt("near_20m", north(CENTER, 20));
        const edge = await connectAt("edge_95m", north(CENTER, 95));
        const outside = await connectAt("outside_110m", north(CENTER, 110));
        const far = await connectAt("far_2km", north(CENTER, 2000));

        const results = Promise.all([near, edge, outside, far].map(receivesMessage));
        await alice.emitWithAck("sendMessage", makeMessage("alice", "who can hear me?"));

        expect(await results).toEqual([true, true, false, false]);
    });

    test("the message's own location is used when provided, not the sender's", async () => {
        const alice = await connectAt("alice", CENTER);
        const bob = await connectAt("bob", north(CENTER, 1000));

        const results = Promise.all([bob, alice].map(receivesMessage));
        await alice.emitWithAck("sendMessage", makeMessage("alice", "dropped near bob", north(CENTER, 1010)));

        expect(await results).toEqual([true, false]);
    });

    test("a client that moves away stops receiving messages", async () => {
        const alice = await connectAt("alice", CENTER);
        const bob = await connectAt("bob", north(CENTER, 30));

        let received = receivesMessage(bob);
        await alice.emitWithAck("sendMessage", makeMessage("alice", "first"));
        expect(await received).toBe(true);

        await bob.emitWithAck("updateLocation", north(CENTER, 500));
        received = receivesMessage(bob);
        await alice.emitWithAck("sendMessage", makeMessage("alice", "second"));
        expect(await received).toBe(false);
    });

    test("a client that disconnects is removed from the region map", async () => {
        const alice = await connectAt("alice", CENTER);
        const bob = await connectAt("bob", north(CENTER, 30));
        bob.disconnect();
        await new Promise((r) => setTimeout(r, 100)); // give the server time to process the disconnect

        // If bob were still in the map the server would try to emit to his closed socket; it should just succeed
        expect(await alice.emitWithAck("sendMessage", makeMessage("alice", "anyone?"))).toBe("success");
        expect(await alice.emitWithAck("getNearbyUsers")).toEqual({ alice: { displayName: "alice", profilePicture: 0 } });
    });

    test("each nearby client receives the message exactly once", async () => {
        const alice = await connectAt("alice", CENTER);
        const bob = await connectAt("bob", north(CENTER, 40));

        let count = 0;
        bob.on("message", () => count++);
        await alice.emitWithAck("sendMessage", makeMessage("alice", "once"));
        await new Promise((r) => setTimeout(r, NO_MESSAGE_WAIT_MS));
        expect(count).toBe(1);
    });

    test("clients on opposite sides of the antimeridian can message each other", async () => {
        const west = await connectAt("west", { lat: 0, lon: 179.9997 });
        const east = await connectAt("east", { lat: 0, lon: -179.9997 }); // ~67 m away

        const received = receivesMessage(east);
        await west.emitWithAck("sendMessage", makeMessage("west", "across the date line"));
        expect(await received).toBe(true);
    });

    test("getNearbyUsers returns only users within 100 m", async () => {
        const alice = await connectAt("alice", CENTER);
        await connectAt("bob", north(CENTER, 60));
        await connectAt("carol", north(CENTER, 300));

        const nearby = await alice.emitWithAck("getNearbyUsers");
        expect(Object.keys(nearby).sort()).toEqual(["alice", "bob"]);
    });
});
