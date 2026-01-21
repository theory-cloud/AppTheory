package apptheory

import "strings"

type CORSConfig struct {
	AllowedOrigins   []string
	AllowCredentials bool
	AllowHeaders     []string
}

func WithCORS(config CORSConfig) Option {
	return func(app *App) {
		app.cors = normalizeCORSConfig(config)
	}
}

func normalizeCORSConfig(in CORSConfig) CORSConfig {
	cfg := CORSConfig{
		AllowedOrigins:   nil,
		AllowCredentials: in.AllowCredentials,
		AllowHeaders:     nil,
	}

	if in.AllowedOrigins != nil {
		cfg.AllowedOrigins = make([]string, 0, len(in.AllowedOrigins))
		for _, origin := range in.AllowedOrigins {
			trimmed := strings.TrimSpace(origin)
			if trimmed == "" {
				continue
			}
			if trimmed == "*" {
				cfg.AllowedOrigins = []string{"*"}
				break
			}
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, trimmed)
		}
	}

	if in.AllowHeaders != nil {
		cfg.AllowHeaders = make([]string, 0, len(in.AllowHeaders))
		for _, header := range in.AllowHeaders {
			trimmed := strings.TrimSpace(header)
			if trimmed == "" {
				continue
			}
			cfg.AllowHeaders = append(cfg.AllowHeaders, trimmed)
		}
	}

	return cfg
}

func corsOriginAllowed(origin string, cfg CORSConfig) bool {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return false
	}
	if cfg.AllowedOrigins == nil {
		return true
	}
	if len(cfg.AllowedOrigins) == 0 {
		return false
	}
	for _, allowed := range cfg.AllowedOrigins {
		if allowed == "*" || allowed == origin {
			return true
		}
	}
	return false
}

func corsAllowHeadersValue(cfg CORSConfig) string {
	if len(cfg.AllowHeaders) > 0 {
		return strings.Join(cfg.AllowHeaders, ", ")
	}
	if cfg.AllowCredentials {
		return "Content-Type, Authorization"
	}
	return ""
}
