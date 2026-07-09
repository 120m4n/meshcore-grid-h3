package models

// Nota: los campos de fecha se manejan como string (formato ISO de SQLite,
// vía datetime('now')) en vez de time.Time, para evitar sorpresas de
// parsing entre el driver mattn/go-sqlite3 y columnas TEXT.

type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

type ReportStatus string

const (
	StatusPending  ReportStatus = "pending"
	StatusApproved ReportStatus = "approved"
	StatusRejected ReportStatus = "rejected"
)

type SignalQuality string

const (
	QualitySinCobertura SignalQuality = "sin_cobertura"
	QualityDebil        SignalQuality = "debil"
	QualityBuena        SignalQuality = "buena"
	QualityExcelente    SignalQuality = "excelente"
)

// QualityScore mapea la calidad de señal a un valor numérico 0..3
// usado para calcular el porcentaje agregado por celda.
var QualityScore = map[SignalQuality]float64{
	QualitySinCobertura: 0,
	QualityDebil:        1,
	QualityBuena:        2,
	QualityExcelente:    3,
}

type User struct {
	ID           string `json:"id"`
	Email        string `json:"email"`
	DisplayName  string `json:"display_name"`
	Role         Role   `json:"role"`
	PasswordHash string `json:"-"`
	CreatedAt    string `json:"created_at"`
}

type Report struct {
	ID                  string        `json:"id"`
	H3Index             string        `json:"h3_index"`
	H3Resolution        int           `json:"h3_resolution"`
	Lat                 float64       `json:"lat"`
	Lon                 float64       `json:"lon"`
	InputMethod         string        `json:"input_method"` // "coords" | "pluscode"
	InputRaw            string        `json:"input_raw,omitempty"`
	ReporterID          string        `json:"reporter_id"`
	ReporterName        string        `json:"reporter_name,omitempty"`
	ReporterDisplayName *string       `json:"reporter_display_name,omitempty"`
	SignalQuality       SignalQuality `json:"signal_quality"`
	Message             string        `json:"message,omitempty"`
	Status              ReportStatus  `json:"status"`
	ReviewedBy          *string       `json:"reviewed_by,omitempty"`
	ReviewedAt          *string       `json:"reviewed_at,omitempty"`
	CreatedAt           string        `json:"created_at"`
}

// CellAggregate es lo que consume el mapa público (endpoint /cells).
type CellAggregate struct {
	H3Index      string  `json:"h3_index"`
	ScorePct     float64 `json:"score_pct"`
	ReportCount  int     `json:"report_count"`
	LastReportAt string  `json:"last_report_at"`
}

// CreateReportInput acepta lat/lon O plus_code, nunca ambos vacíos.
type CreateReportInput struct {
	Lat                 *float64      `json:"lat"`
	Lon                 *float64      `json:"lon"`
	PlusCode            *string       `json:"plus_code"`
	ReporterDisplayName *string       `json:"reporter_display_name"`
	SignalQuality       SignalQuality `json:"signal_quality" binding:"required,oneof=sin_cobertura debil buena excelente"`
	Message             string        `json:"message" binding:"max=120"`
}

// CellOrigin es un área de plus code (nivel 10, ~13m) que originó uno
// o más reportes aprobados de una celda H3 — ver CellHandler.Origins.
type CellOrigin struct {
	PlusCode string  `json:"plus_code"`
	LatLo    float64 `json:"lat_lo"`
	LatHi    float64 `json:"lat_hi"`
	LngLo    float64 `json:"lng_lo"`
	LngHi    float64 `json:"lng_hi"`
}
