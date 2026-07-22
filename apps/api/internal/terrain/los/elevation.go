package los

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// ElevationProvider resuelve la elevación (msnm) de un punto. Interfaz
// separada de HTTPElevationProvider para poder inyectar un fake en
// tests de Simulator/handler sin levantar un servidor HTTP real.
type ElevationProvider interface {
	ElevationAt(ctx context.Context, lat, lon float64) (float64, error)
}

// DemCoverageError: el DEM respondió que el punto está fuera de su área
// de cobertura (confirmado contra la API real: 400 con
// {"error":"The point is not contained in the Colombia polygon."}).
type DemCoverageError struct{ Message string }

func (e *DemCoverageError) Error() string { return e.Message }

// DemUnavailableError: el servicio DEM no respondió (red caída,
// timeout, 5xx) — distinto de "punto sin datos".
type DemUnavailableError struct{ Cause error }

func (e *DemUnavailableError) Error() string {
	return fmt.Sprintf("DEM backend no disponible: %v", e.Cause)
}
func (e *DemUnavailableError) Unwrap() error { return e.Cause }

type HTTPElevationProvider struct {
	BaseURL string
	Client  *http.Client
}

func NewHTTPElevationProvider(baseURL string) *HTTPElevationProvider {
	return &HTTPElevationProvider{
		BaseURL: baseURL,
		Client: &http.Client{
			Timeout: 5 * time.Second,
			Transport: &http.Transport{
				MaxIdleConnsPerHost: maxConcurrentElevationRequests,
			},
		},
	}
}

type elevationRequestBody struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

type elevationResponseBody struct {
	Elevation float64 `json:"elevation"`
}

type elevationErrorBody struct {
	Error string `json:"error"`
}

func (p *HTTPElevationProvider) ElevationAt(ctx context.Context, lat, lon float64) (float64, error) {
	payload, err := json.Marshal(elevationRequestBody{Lat: lat, Lon: lon})
	if err != nil {
		return 0, &DemUnavailableError{Cause: err}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/elevation", bytes.NewReader(payload))
	if err != nil {
		return 0, &DemUnavailableError{Cause: err}
	}
	req.Header.Set("Content-Type", "application/json")

	res, err := p.Client.Do(req)
	if err != nil {
		return 0, &DemUnavailableError{Cause: err}
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusOK {
		var body elevationResponseBody
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			return 0, &DemUnavailableError{Cause: err}
		}
		return body.Elevation, nil
	}

	var errBody elevationErrorBody
	_ = json.NewDecoder(res.Body).Decode(&errBody)
	if errBody.Error == "" {
		errBody.Error = fmt.Sprintf("DEM respondió %d", res.StatusCode)
	}

	if res.StatusCode == http.StatusBadRequest {
		return 0, &DemCoverageError{Message: errBody.Error}
	}
	return 0, &DemUnavailableError{Cause: fmt.Errorf("%s (status %d)", errBody.Error, res.StatusCode)}
}

const maxConcurrentElevationRequests = 24
