// Chequeo: node --experimental-strip-types apps/web/src/lib/map/repeatersCheck.mjs
import { parseRepeaters } from "./repeatersParse.ts";
import assert from "node:assert";

const ok = { latitude: 6.8, longitude: -73.2, name: "WTJ 3 ", hashPrefix: "9a" };
const r = parseRepeaters([ok, { ...ok, latitude: 91 }, { ...ok, name: " " }, { ...ok, hashPrefix: 5 }, null]);
assert.equal(r.fc.features.length, 1);
assert.equal(r.skipped, 4);
assert.deepEqual(r.fc.features[0].geometry.coordinates, [-73.2, 6.8]);
assert.deepEqual(r.fc.features[0].properties, { name: "WTJ 3", hashPrefix: "9A" });
assert.equal(parseRepeaters({}), null);
assert.equal(parseRepeaters([]).fc.features.length, 0);
console.log("ok");
