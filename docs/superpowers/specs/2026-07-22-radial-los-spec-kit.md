# Spec kit — simulación radial 360° con colisión en montaña (LOS)

## 1) Contexto y estado actual del repo

- Backend actual: Go + Gin + SQLite + H3, con handlers SQL inline y sin
  motor de simulación de propagación o line-of-sight.
- Frontend actual: Astro + Leaflet, con capas (`L.layerGroup`) y
  renderizado de geometrías sobre mapa (hexágonos H3, rectángulos de
  origen), patrón reutilizable para rayos radiales.
- Infra actual: no hay dependencia geoespacial pesada instalada
  (PostGIS/GDAL) en runtime.

Conclusión: la feature se implementa como módulo nuevo, sin romper
`reports`, `cell_agg` ni flujos de moderación existentes.

## 2) Objetivo funcional

Dado un punto origen (`lat`, `lon`) y altura `z`, simular una barrida
radial 360° y determinar para cada ángulo la distancia máxima de señal
hasta:

1. primer obstáculo topográfico (colisión con montaña), o
2. distancia máxima configurada.

El usuario ve un diagrama tipo radar en el mapa: una línea por ángulo
desde el origen hasta el punto final de ese rayo.

## 3) Definiciones clave

- **LOS (line-of-sight)**: visibilidad geométrica entre el origen y cada
  muestra de terreno del rayo.
- **Colisión**: primer punto donde la elevación del terreno bloquea la
  línea de visión calculada.
- **z (altura de origen)**: requiere definición de producto:
  - alternativa A: altura absoluta sobre nivel del mar (msnm),
  - alternativa B: altura de antena sobre terreno local.

## 4) Alcance (MVP)

Incluye:

- Endpoint de simulación radial bajo `/api/v1/simulations/radial`.
- Cálculo backend de rayos con paso angular configurable.
- Muestreo de elevación en cada rayo con paso en metros configurable.
- Render frontend de rayos y punto origen.
- Metadatos de cómputo y fuente DEM en respuesta.

Excluye (MVP):

- Modelo RF avanzado (difracción, pérdidas por clutter, Fresnel).
- Persistencia histórica obligatoria de simulaciones.
- Animación temporal y comparación multi-escenario.

## 5) Contrato API propuesto

### 5.1 Endpoint

`POST /api/v1/simulations/radial`

### 5.2 Request JSON

```json
{
  "origin_lat": 7.1193,
  "origin_lon": -73.1227,
  "origin_height_m": 960,
  "angle_step_deg": 1,
  "max_distance_m": 15000,
  "sample_step_m": 30,
  "earth_curvature": true,
  "refraction_k": 0.13
}
```

### 5.3 Reglas de validación

- `origin_lat` en `[-90, 90]`.
- `origin_lon` en `[-180, 180]`.
- `origin_height_m` `>= 0` y `<= 9000`.
- `angle_step_deg` en `(0, 45]` (MVP recomendado: `1,2,5`).
- `max_distance_m` en `[100, 100000]`.
- `sample_step_m` en `[5, 250]`.
- `refraction_k` opcional; si falta, usar default de sistema.
- Validar cobertura DEM del área objetivo; si no hay cobertura
  suficiente, retornar error explícito.

### 5.4 Response 200 JSON

```json
{
  "rays": [
    {
      "angle_deg": 0,
      "end_lat": 7.2101,
      "end_lon": -73.1227,
      "distance_m": 10320,
      "collided": true,
      "collision_lat": 7.2101,
      "collision_lon": -73.1227,
      "collision_elev_m": 1488.4
    }
  ],
  "metadata": {
    "dem_source": "copernicus-glo30-v2024-1",
    "dem_resolution_m": 30,
    "compute_ms": 412
  }
}
```

### 5.5 Errores API

- `400 bad_request`: parámetros inválidos.
- `422 dem_coverage_insufficient`: origen/rayos fuera de cobertura DEM.
- `429 too_many_requests`: límite de rate aplicado.
- `500 simulation_failed`: error interno de cálculo o lectura DEM.
- `503 dem_backend_unavailable`: DEM/API no disponible.

Formato recomendado de error:

```json
{
  "error": "dem_coverage_insufficient",
  "message": "No hay cobertura DEM para el área solicitada"
}
```

## 6) Matriz de parámetros y límites operativos

| Parámetro | Tipo | Requerido | Rango/Valores | Default sugerido | Impacto |
|---|---|---:|---|---|---|
| `origin_lat` | number | Sí | -90..90 | N/A | define origen |
| `origin_lon` | number | Sí | -180..180 | N/A | define origen |
| `origin_height_m` | number | Sí | 0..9000 | N/A | altitud/antena |
| `angle_step_deg` | number | Sí | (0,45] | 2 | precisión angular vs costo |
| `max_distance_m` | number | Sí | 100..100000 | 15000 | alcance simulado |
| `sample_step_m` | number | Sí | 5..250 | 30 | precisión vertical vs latencia |
| `earth_curvature` | bool | Sí | true/false | true | realism a larga distancia |
| `refraction_k` | number | No | 0..0.5 | 0.13 | ajuste curvatura efectiva |

## 7) Diseño técnico propuesto

## 7.1 Backend (Go)

Nuevo paquete:

- `apps/api/internal/terrain/los`

Responsabilidades:

- Generación de ángulos según `angle_step_deg`.
- Proyección geodésica punto destino por azimut + distancia.
- Muestreo incremental (`sample_step_m`) sobre perfil DEM.
- Detección de primera colisión por rayo.
- Armado de `rays[]` + `metadata`.

Interfaz interna recomendada:

- `Simulator.Run(ctx, request) -> response`
- `ElevationProvider.ElevationAt(lat, lon) -> elev_m`

### 7.2 Router/handler

- Registrar `POST /api/v1/simulations/radial` en
  `apps/api/internal/router/router.go`.
- Handler nuevo en `apps/api/internal/handlers` con validación de input,
  mapeo de errores y respuesta JSON.

### 7.3 Frontend (Leaflet)

Cambios en módulo de mapa:

- Nueva capa `radialLayer` para líneas de rayos (`L.polyline`).
- UI de parámetros (step angular, distancia máxima, altura, etc.).
- Colores diferenciados:
  - rayo con colisión,
  - rayo sin colisión (alcance máximo).

No se modifica el flujo principal de reportes/celdas; se agrega una
visualización superpuesta.

## 8) Solicitud formal de herramientas (bloqueantes)

Para ejecutar la implementación se solicita aprobación/provisión de:

1. **Fuente DEM para Santander**
   - Opción A: Copernicus GLO-30 o SRTM 30m (GeoTIFF).
   - Opción B: API de elevación con SLA y límites de cuota documentados.

2. **Motor/librerías de cálculo geodésico y perfil altimétrico en Go**
   - Destino geodésico por azimut+distancia.
   - Muestreo robusto de elevación sobre DEM raster.

3. **Almacenamiento/caché de DEM**
   - Bucket o ruta versionada de raster,
   - política de versionado y actualización.

4. **Definición de producto obligatoria**
   - significado exacto de `origin_height_m`,
   - rango máximo permitido (km),
   - precisión esperada,
   - SLA/latencia máxima por simulación.

Sin estos insumos no se garantiza exactitud ni operación estable del
modelo de colisión topográfica.

## 9) Herramientas recomendadas (alto valor, no bloqueantes)

- Pipeline offline de preprocesamiento DEM (GDAL o equivalente).
- Cache de resultados por hash de parámetros de entrada.
- Dataset de puntos de control para validación de exactitud.

## 10) Riesgos y decisiones abiertas

1. Ambigüedad de `z` (msnm vs altura sobre terreno).
2. Trade-off precisión/latencia por (`angle_step_deg`, `sample_step_m`).
3. Curvatura y refracción: activar en MVP o fase 2.
4. Cobertura/resolución DEM insuficiente en zonas de topografía extrema.
5. Dependencia de servicios externos si se usa API en vez de raster local.

## 11) Criterios de aceptación (spec kit)

- Existe contrato API cerrado (request/response/errores) y validado por
  backend+frontend.
- Parámetros tienen límites explícitos y defaults acordados.
- Flujo de colisión “primer obstáculo” está definido sin ambigüedades.
- Herramientas bloqueantes quedan aprobadas o rechazadas con decisión
  explícita.
- Se define objetivo de rendimiento (p95/p99) y precisión mínima.
- La propuesta no afecta datos persistidos actuales (`reports`, `cell_agg`).

## 12) Plan de verificación para implementación futura

- Pruebas unitarias de geometría y detección de colisión por rayo.
- Pruebas de integración con DEM real en celdas de Santander.
- Prueba visual frontend: radar 360°, estilos, leyenda, interacción.
- Benchmark por combinaciones de `angle_step_deg` y `sample_step_m`.
