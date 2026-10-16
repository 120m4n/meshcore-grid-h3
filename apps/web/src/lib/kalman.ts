// Filtro de Kalman 1D aplicado a lat y lon por separado, con la varianza
// medida en m². Cada lectura pesa según su accuracy: las imprecisas casi
// no mueven el punto y el error estimado converge con las lecturas.
const Q_M_PER_S = 3; // ruido de proceso ≈ velocidad máx. a pie; ponytail: subir si se usa en vehículo
const MIN_ACCURACY_M = 1;

export interface Estimate { lat: number; lon: number; accuracy: number }

export class GeoKalman {
  private est: Estimate | null = null;
  private variance = 0;
  private ts = 0;

  update(lat: number, lon: number, accuracy: number, ts: number): Estimate {
    const acc = Math.max(accuracy, MIN_ACCURACY_M);
    if (!this.est) {
      this.est = { lat, lon, accuracy: acc };
      this.variance = acc * acc;
      this.ts = ts;
      return this.est;
    }
    const dt = Math.max(ts - this.ts, 0) / 1000;
    this.ts = ts;
    this.variance += dt * Q_M_PER_S * Q_M_PER_S;
    const k = this.variance / (this.variance + acc * acc);
    this.est = {
      lat: this.est.lat + k * (lat - this.est.lat),
      lon: this.est.lon + k * (lon - this.est.lon),
      accuracy: 0,
    };
    this.variance *= 1 - k;
    this.est.accuracy = Math.max(Math.sqrt(this.variance), MIN_ACCURACY_M);
    return this.est;
  }
}
