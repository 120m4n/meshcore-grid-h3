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

type NetworkType string

const (
	Net2G          NetworkType = "2g"
	Net3G          NetworkType = "3g"
	NetLTE         NetworkType = "lte"
	Net5G          NetworkType = "5g"
	NetDesconocido NetworkType = "desconocido"
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
	NetworkType         NetworkType   `json:"network_type"`
	Message             string        `json:"message,omitempty"`
	Status              ReportStatus  `json:"status"`
	ReviewedBy          *string       `json:"reviewed_by,omitempty"`
	ReviewedAt          *string       `json:"reviewed_at,omitempty"`
	CreatedAt           string        `json:"created_at"`
}

// CellAggregate es lo que consume el mapa público (endpoint /cells) —
// también lo reutiliza la tabla "Celdas activas" del admin (mismo
// endpoint, sin duplicar query). PlusCode se calcula al servir la
// respuesta (ver h3util.CellPlusCode), no vive en la tabla cell_agg.
// ManualOverride indica si score_pct está "fijado" a mano por un admin
// (ver cell_overrides) en vez del promedio automático de reportes.
type CellAggregate struct {
	H3Index        string  `json:"h3_index"`
	ScorePct       float64 `json:"score_pct"`
	ReportCount    int     `json:"report_count"`
	LastReportAt   string  `json:"last_report_at"`
	PlusCode       string  `json:"plus_code"`
	ManualOverride bool    `json:"manual_override"`
}

// CellPage es la respuesta de GET /cells cuando se pasa el query param
// "page" — usado por la tabla "Celdas activas" del admin. Sin "page" el
// endpoint devuelve el array plano de siempre (lo consume el mapa
// público, que necesita todas las celdas de una sola vez).
type CellPage struct {
	Items    []CellAggregate `json:"items"`
	Total    int             `json:"total"`
	Page     int             `json:"page"`
	PageSize int             `json:"page_size"`
}

// CreateReportInput acepta lat/lon O plus_code, nunca ambos vacíos.
type CreateReportInput struct {
	Lat                 *float64      `json:"lat"`
	Lon                 *float64      `json:"lon"`
	PlusCode            *string       `json:"plus_code"`
	ReporterDisplayName *string       `json:"reporter_display_name"`
	SignalQuality       SignalQuality `json:"signal_quality" binding:"required,oneof=sin_cobertura debil buena excelente"`
	NetworkType         NetworkType   `json:"network_type" binding:"omitempty,oneof=2g 3g lte 5g desconocido"`
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

// InviteCode es de un solo uso: Register lo consume atómicamente al
// crear la cuenta (ver AuthHandler.Register). UsedBy/UsedAt viajan
// como punteros porque quedan NULL hasta ese momento.
type InviteCode struct {
	Code      string  `json:"code"`
	CreatedBy string  `json:"created_by"`
	CreatedAt string  `json:"created_at"`
	ExpiresAt string  `json:"expires_at"`
	UsedBy    *string `json:"used_by,omitempty"`
	UsedAt    *string `json:"used_at,omitempty"`
}
