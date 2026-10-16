// Chequeo: node --experimental-strip-types apps/web/src/lib/kalmanCheck.mjs
import assert from "node:assert";
import { GeoKalman } from "./kalman.ts";

const k = new GeoKalman();
let e = k.update(7.0, -73.0, 20, 0);
assert.deepEqual([e.lat, e.lon, e.accuracy], [7.0, -73.0, 20]);
// lectura muy imprecisa casi no mueve el punto
e = k.update(7.001, -73.001, 500, 1000);
assert.ok(Math.abs(e.lat - 7.0) < 0.0001);
// lecturas buenas repetidas: converge y el error baja
for (let t = 2; t < 30; t++) e = k.update(7.0005, -73.0005, 5, t * 1000);
assert.ok(Math.abs(e.lat - 7.0005) < 0.00005);
assert.ok(e.accuracy < 5);
console.log("ok");
