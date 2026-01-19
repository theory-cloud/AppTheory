package limited

import (
	"strings"
	"time"
)

// FixedWindowStrategy implements fixed-window rate limiting.
type FixedWindowStrategy struct {
	WindowSize  time.Duration
	MaxRequests int

	IdentifierLimits map[string]int
	ResourceLimits   map[string]int
}

func NewFixedWindowStrategy(windowSize time.Duration, maxRequests int) *FixedWindowStrategy {
	return &FixedWindowStrategy{
		WindowSize:       windowSize,
		MaxRequests:      maxRequests,
		IdentifierLimits: make(map[string]int),
		ResourceLimits:   make(map[string]int),
	}
}

func (s *FixedWindowStrategy) CalculateWindows(now time.Time) []TimeWindow {
	if s.WindowSize <= 0 {
		return nil
	}

	windowStart := s.getWindowStart(now)
	windowEnd := windowStart.Add(s.WindowSize)

	return []TimeWindow{{
		Start: windowStart,
		End:   windowEnd,
		Key:   windowStart.Format(time.RFC3339),
	}}
}

func (s *FixedWindowStrategy) GetLimit(key RateLimitKey) int {
	if limit, ok := s.IdentifierLimits[key.Identifier]; ok {
		return limit
	}
	if limit, ok := s.ResourceLimits[key.Resource]; ok {
		return limit
	}
	return s.MaxRequests
}

func (s *FixedWindowStrategy) ShouldAllow(counts map[string]int, limit int) bool {
	total := 0
	for _, count := range counts {
		total += count
	}
	return total < limit
}

func (s *FixedWindowStrategy) getWindowStart(now time.Time) time.Time {
	windowNanos := s.WindowSize.Nanoseconds()
	if windowNanos <= 0 {
		return now
	}

	startNanos := (now.UnixNano() / windowNanos) * windowNanos
	return time.Unix(0, startNanos).In(now.Location())
}

func (s *FixedWindowStrategy) SetIdentifierLimit(identifier string, limit int) {
	s.IdentifierLimits[identifier] = limit
}

func (s *FixedWindowStrategy) SetResourceLimit(resource string, limit int) {
	s.ResourceLimits[resource] = limit
}

// SlidingWindowStrategy implements sliding-window rate limiting.
type SlidingWindowStrategy struct {
	WindowSize  time.Duration
	MaxRequests int
	Granularity time.Duration

	IdentifierLimits map[string]int
	ResourceLimits   map[string]int
}

func NewSlidingWindowStrategy(windowSize time.Duration, maxRequests int, granularity time.Duration) *SlidingWindowStrategy {
	return &SlidingWindowStrategy{
		WindowSize:       windowSize,
		MaxRequests:      maxRequests,
		Granularity:      granularity,
		IdentifierLimits: make(map[string]int),
		ResourceLimits:   make(map[string]int),
	}
}

func (s *SlidingWindowStrategy) CalculateWindows(now time.Time) []TimeWindow {
	if s.WindowSize <= 0 {
		return nil
	}

	granularity := s.Granularity
	if granularity <= 0 {
		granularity = time.Minute
	}

	subWindows := int(s.WindowSize / granularity)
	if subWindows < 1 {
		subWindows = 1
	}

	currentStart := now.Truncate(granularity)

	windows := make([]TimeWindow, 0, subWindows)
	for i := 0; i < subWindows; i++ {
		start := currentStart.Add(-time.Duration(i) * granularity)
		if now.Sub(start) > s.WindowSize {
			continue
		}
		end := start.Add(granularity)
		windows = append(windows, TimeWindow{
			Start: start,
			End:   end,
			Key:   start.Format(time.RFC3339),
		})
	}

	return windows
}

func (s *SlidingWindowStrategy) GetLimit(key RateLimitKey) int {
	if limit, ok := s.IdentifierLimits[key.Identifier]; ok {
		return limit
	}
	if limit, ok := s.ResourceLimits[key.Resource]; ok {
		return limit
	}
	return s.MaxRequests
}

func (s *SlidingWindowStrategy) ShouldAllow(counts map[string]int, limit int) bool {
	total := 0
	for _, count := range counts {
		total += count
	}
	return total < limit
}

func (s *SlidingWindowStrategy) SetIdentifierLimit(identifier string, limit int) {
	s.IdentifierLimits[identifier] = limit
}

func (s *SlidingWindowStrategy) SetResourceLimit(resource string, limit int) {
	s.ResourceLimits[resource] = limit
}

// MultiWindowStrategy enforces multiple limits simultaneously (for example: 100/min AND 1000/hour).
type MultiWindowStrategy struct {
	Windows          []WindowConfig
	IdentifierLimits map[string][]WindowConfig
	ResourceLimits   map[string][]WindowConfig
}

type WindowConfig struct {
	Duration    time.Duration
	MaxRequests int
}

func NewMultiWindowStrategy(windows []WindowConfig) *MultiWindowStrategy {
	return &MultiWindowStrategy{
		Windows:          append([]WindowConfig(nil), windows...),
		IdentifierLimits: make(map[string][]WindowConfig),
		ResourceLimits:   make(map[string][]WindowConfig),
	}
}

func (s *MultiWindowStrategy) CalculateWindows(now time.Time) []TimeWindow {
	if len(s.Windows) == 0 {
		return nil
	}

	windows := make([]TimeWindow, 0, len(s.Windows))
	for _, config := range s.Windows {
		if config.Duration <= 0 {
			continue
		}
		window := GetFixedWindow(now, config.Duration)
		windows = append(windows, TimeWindow{
			Start: window.Start,
			End:   window.End,
			Key:   window.Start.Format(time.RFC3339) + "_" + config.Duration.String(),
		})
	}
	return windows
}

func (s *MultiWindowStrategy) GetLimit(key RateLimitKey) int {
	limits := s.limitsForKey(key)
	if len(limits) == 0 {
		return 0
	}
	return limits[0].MaxRequests
}

func (s *MultiWindowStrategy) ShouldAllow(counts map[string]int, limit int) bool {
	if len(s.Windows) == 0 {
		return false
	}

	// Map counts deterministically by duration suffix (mirrors CalculateWindows keys).
	for _, config := range s.Windows {
		if config.Duration <= 0 {
			continue
		}
		max := config.MaxRequests
		suffix := "_" + config.Duration.String()

		count := 0
		for key, observed := range counts {
			if strings.HasSuffix(key, suffix) {
				count = observed
				break
			}
		}

		if count >= max {
			return false
		}
	}

	return true
}

func (s *MultiWindowStrategy) limitsForKey(key RateLimitKey) []WindowConfig {
	if limits, ok := s.IdentifierLimits[key.Identifier]; ok && len(limits) > 0 {
		return limits
	}
	if limits, ok := s.ResourceLimits[key.Resource]; ok && len(limits) > 0 {
		return limits
	}
	return s.Windows
}
