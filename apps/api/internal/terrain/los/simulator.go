package los

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"
)

// MaxTotalSamples acota rays * samples-por-rayo de una simulación. El
// DEM es una API HTTP de un solo punto (~15-20ms/llamada medido contra
// el servicio real) — sin este tope, defaults grandes de
// angle_step_deg/sample_step_m/max_distance_m tardarían decenas de
// segundos, incompatible con un endpoint síncrono. Ver ValidateRequest
// (models_validation.go) para el rechazo con 400 cuando se excede.
const MaxTotalSamples = 8000

// maxConcurrentElevationRequests: definida en elevation.go, reutilizada
// acá para el pool de goroutines que resuelve elevaciones en paralelo.

type SimulationInput struct {
	OriginLat      float64
	OriginLon      float64
	OriginHeightM  float64
	AngleStepDeg   float64
	MaxDistanceM   float64
	SampleStepM    float64
	EarthCurvature bool
	RefractionK    float64
	StartAngleDeg  float64
	EndAngleDeg    float64
}

type Metadata struct {
	DemSource      string
	DemResolutionM float64
	ComputeMs      int64
}

type Response struct {
	Rays     []Ray
	Metadata Metadata
}

type Simulator struct {
	Elevation      ElevationProvider
	DemSourceLabel string
	DemResolutionM float64
}

type point struct{ lat, lon float64 }

func (s *Simulator) Run(ctx context.Context, in SimulationInput) (*Response, error) {
	start := time.Now()

	rayCount := int(math.Ceil(360 / in.AngleStepDeg))
	samplesPerRay := int(math.Ceil(in.MaxDistanceM / in.SampleStepM))

	distances := make([]float64, samplesPerRay)
	for j := 0; j < samplesPerRay; j++ {
		d := float64(j+1) * in.SampleStepM
		if d > in.MaxDistanceM {
			d = in.MaxDistanceM
		}
		distances[j] = d
	}

	angles := make([]float64, rayCount)
	// points[0] = origen; points[1+i*samplesPerRay+j] = muestra j del rayo i.
	points := make([]point, 1+rayCount*samplesPerRay)
	points[0] = point{in.OriginLat, in.OriginLon}
	for i := 0; i < rayCount; i++ {
		angle := float64(i) * in.AngleStepDeg
		angles[i] = angle
		for j := 0; j < samplesPerRay; j++ {
			lat, lon := Destination(in.OriginLat, in.OriginLon, angle, distances[j])
			points[1+i*samplesPerRay+j] = point{lat, lon}
		}
	}

	elevations, err := s.fetchElevations(ctx, points)
	if err != nil {
		return nil, err
	}

	originElevM := elevations[0] + in.OriginHeightM

	rays := make([]Ray, rayCount)
	for i := 0; i < rayCount; i++ {
		samples := make([]Sample, samplesPerRay)
		for j := 0; j < samplesPerRay; j++ {
			idx := 1 + i*samplesPerRay + j
			samples[j] = Sample{
				DistanceM: distances[j],
				Lat:       points[idx].lat,
				Lon:       points[idx].lon,
				ElevM:     elevations[idx],
			}
		}
		rays[i] = EvaluateRay(angles[i], originElevM, samples, in.EarthCurvature, in.RefractionK)
	}

	return &Response{
		Rays: rays,
		Metadata: Metadata{
			DemSource:      s.DemSourceLabel,
			DemResolutionM: s.DemResolutionM,
			ComputeMs:      time.Since(start).Milliseconds(),
		},
	}, nil
}

// fetchElevations resuelve todos los puntos en paralelo, acotado a
// maxConcurrentElevationRequests llamadas simultáneas (evita saturar el
// DEM de un solo punto con miles de goroutines a la vez). points[0] es
// siempre el origen: un error ahí (de cobertura o de disponibilidad)
// aborta toda la simulación. Un DemCoverageError en un punto que NO es
// el origen no aborta nada — se marca con NaN para que EvaluateRay
// trunque ese rayo puntual ahí. Un DemUnavailableError en cualquier
// punto sí aborta toda la simulación (el DEM está caído, reintentar no
// tiene sentido a mitad de un sweep).
func (s *Simulator) fetchElevations(ctx context.Context, points []point) ([]float64, error) {
	elevations := make([]float64, len(points))
	errs := make([]error, len(points))

	sem := make(chan struct{}, maxConcurrentElevationRequests)
	var wg sync.WaitGroup
	for i, p := range points {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, p point) {
			defer wg.Done()
			defer func() { <-sem }()
			elev, err := s.Elevation.ElevationAt(ctx, p.lat, p.lon)
			elevations[i] = elev
			errs[i] = err
		}(i, p)
	}
	wg.Wait()

	if errs[0] != nil {
		return nil, fmt.Errorf("origen: %w", errs[0])
	}

	for i, err := range errs {
		if err == nil {
			continue
		}
		var unavailableErr *DemUnavailableError
		if errors.As(err, &unavailableErr) {
			return nil, err
		}
		// DemCoverageError en un punto intermedio: truncar ese rayo ahí.
		elevations[i] = demCoverageGapMarker
	}
	return elevations, nil
}
