package los

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPElevationProviderSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Lat, Lon float64 }
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Lat != 4.6097 || body.Lon != -74.0817 {
			t.Errorf("body inesperado: %+v", body)
		}
		json.NewEncoder(w).Encode(map[string]float64{
			"elevation": 2581, "lat": body.Lat, "lon": body.Lon,
		})
	}))
	defer srv.Close()

	p := NewHTTPElevationProvider(srv.URL)
	elev, err := p.ElevationAt(context.Background(), 4.6097, -74.0817)
	if err != nil {
		t.Fatalf("error inesperado: %v", err)
	}
	if elev != 2581 {
		t.Errorf("elev = %v, want 2581", elev)
	}
}

func TestHTTPElevationProviderCoverageError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{
			"error": "The point is not contained in the Colombia polygon.",
		})
	}))
	defer srv.Close()

	p := NewHTTPElevationProvider(srv.URL)
	_, err := p.ElevationAt(context.Background(), 0, 0)
	var coverageErr *DemCoverageError
	if !errors.As(err, &coverageErr) {
		t.Fatalf("esperaba *DemCoverageError, got %T: %v", err, err)
	}
}

func TestHTTPElevationProviderServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	p := NewHTTPElevationProvider(srv.URL)
	_, err := p.ElevationAt(context.Background(), 4.6, -74.0)
	var unavailableErr *DemUnavailableError
	if !errors.As(err, &unavailableErr) {
		t.Fatalf("esperaba *DemUnavailableError, got %T: %v", err, err)
	}
}

func TestHTTPElevationProviderConnectionRefused(t *testing.T) {
	p := NewHTTPElevationProvider("http://127.0.0.1:1") // puerto que nadie escucha
	_, err := p.ElevationAt(context.Background(), 4.6, -74.0)
	var unavailableErr *DemUnavailableError
	if !errors.As(err, &unavailableErr) {
		t.Fatalf("esperaba *DemUnavailableError, got %T: %v", err, err)
	}
}
