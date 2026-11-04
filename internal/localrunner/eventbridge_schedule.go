package localrunner

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule expressions for EventBridge scheduled rules. A rate expression fires
// at a regular interval; a cron expression has the six documented fields and
// fires at minute precision in UTC.
//
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html
// https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html
//
// The runner implements the documented wildcards * ? , - / and month/day names.
// ? marks a day field with no specific value, so the other day field carries
// the only constraint; * is refused when it appears in both day fields. The L, W
// and # forms are refused at plan time with the rule named rather than accepted
// and fired at the wrong minute.

// scheduleSpec is one parsed scheduled rule.
type scheduleSpec struct {
	// rateInterval is set for rate(...) expressions.
	rateInterval time.Duration
	// cron is set for cron(...) expressions.
	cron *cronSpec
}

// parseScheduleExpression parses rate(...) or cron(...).
func parseScheduleExpression(expression string) (scheduleSpec, error) {
	trimmed := strings.TrimSpace(expression)
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "rate(") && strings.HasSuffix(trimmed, ")"):
		interval, err := parseRateExpression(trimmed[len("rate(") : len(trimmed)-1])
		if err != nil {
			return scheduleSpec{}, err
		}
		return scheduleSpec{rateInterval: interval}, nil
	case strings.HasPrefix(lower, "cron(") && strings.HasSuffix(trimmed, ")"):
		cron, err := parseCronExpression(trimmed[len("cron(") : len(trimmed)-1])
		if err != nil {
			return scheduleSpec{}, err
		}
		return scheduleSpec{cron: cron}, nil
	default:
		return scheduleSpec{}, fmt.Errorf("schedule expression %q must be rate(...) or cron(...)", expression)
	}
}

// next returns the first occurrence strictly after now.
func (s scheduleSpec) next(now time.Time) (time.Time, error) {
	now = now.UTC().Truncate(time.Minute)
	if s.rateInterval > 0 {
		return now.Add(s.rateInterval), nil
	}
	if s.cron == nil {
		return time.Time{}, fmt.Errorf("the schedule expression is empty")
	}
	return s.cron.next(now)
}

// parseRateExpression parses "<value> <unit>".
func parseRateExpression(expression string) (time.Duration, error) {
	fields := strings.Fields(expression)
	if len(fields) != 2 {
		return 0, fmt.Errorf("rate expression %q needs a value and a unit", expression)
	}
	value, err := strconv.Atoi(fields[0])
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("rate value %q must be a positive integer", fields[0])
	}
	unit := strings.ToLower(fields[1])
	if value == 1 && strings.HasSuffix(unit, "s") {
		return 0, fmt.Errorf("rate(1 %s) is invalid: a value of 1 uses the singular unit", unit)
	}
	if value > 1 && !strings.HasSuffix(unit, "s") {
		return 0, fmt.Errorf("rate(%d %s) is invalid: a value greater than 1 uses the plural unit", value, unit)
	}
	var base time.Duration
	switch strings.TrimSuffix(unit, "s") {
	case "minute":
		base = time.Minute
	case "hour":
		base = time.Hour
	case "day":
		base = 24 * time.Hour
	default:
		return 0, fmt.Errorf("rate unit %q must be minute, hour or day", unit)
	}
	return time.Duration(value) * base, nil
}

// cronSpec is a parsed six-field cron expression.
type cronSpec struct {
	minute     fieldSet
	hour       fieldSet
	dayOfMonth fieldSet
	month      fieldSet
	dayOfWeek  fieldSet
	year       fieldSet
	// dayOfMonthAny and dayOfWeekAny record a ? day field. ? is not a
	// wildcard: AWS uses it for a day field with no specific value, so the
	// other day field carries the only constraint and is evaluated alone.
	dayOfMonthAny bool
	dayOfWeekAny  bool
}

// fieldSet is one cron field's allowed values.
type fieldSet struct {
	values map[int]struct{}
}

func (f fieldSet) contains(value int) bool {
	_, ok := f.values[value]
	return ok
}

var (
	cronMonthNames = map[string]int{
		"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
		"JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
	}
	cronDayNames = map[string]int{
		"SUN": 1, "MON": 2, "TUE": 3, "WED": 4, "THU": 5, "FRI": 6, "SAT": 7,
	}
)

// parseCronExpression parses the six required fields.
func parseCronExpression(expression string) (*cronSpec, error) {
	fields := strings.Fields(expression)
	if len(fields) != 6 {
		return nil, fmt.Errorf("cron expression %q needs six fields", expression)
	}
	minute, err := parseCronField(fields[0], 0, 59, nil)
	if err != nil {
		return nil, fmt.Errorf("cron minutes: %w", err)
	}
	hour, err := parseCronField(fields[1], 0, 23, nil)
	if err != nil {
		return nil, fmt.Errorf("cron hours: %w", err)
	}
	dayOfMonth, err := parseCronField(fields[2], 1, 31, nil)
	if err != nil {
		return nil, fmt.Errorf("cron day-of-month: %w", err)
	}
	month, err := parseCronField(fields[3], 1, 12, cronMonthNames)
	if err != nil {
		return nil, fmt.Errorf("cron month: %w", err)
	}
	dayOfWeek, err := parseCronField(fields[4], 1, 7, cronDayNames)
	if err != nil {
		return nil, fmt.Errorf("cron day-of-week: %w", err)
	}
	year, err := parseCronField(fields[5], 1970, 2199, nil)
	if err != nil {
		return nil, fmt.Errorf("cron year: %w", err)
	}
	if strings.Contains(fields[4], "#") {
		return nil, fmt.Errorf("cron day-of-week # is not implemented locally")
	}
	if strings.Contains(fields[2], "*") && strings.Contains(fields[4], "*") {
		return nil, fmt.Errorf("cron day-of-month and day-of-week: * in both fields is not allowed; use ? in one of them")
	}
	return &cronSpec{
		minute:        minute,
		hour:          hour,
		dayOfMonth:    dayOfMonth,
		month:         month,
		dayOfWeek:     dayOfWeek,
		year:          year,
		dayOfMonthAny: fields[2] == "?",
		dayOfWeekAny:  fields[4] == "?",
	}, nil
}

// parseCronField parses one field into its allowed values. names maps a name to
// its numeric value (months and weekdays).
//
//nolint:gocognit,gocyclo // one branch per cron wildcard.
func parseCronField(field string, minimum, maximum int, names map[string]int) (fieldSet, error) {
	if field == "?" || field == "*" {
		return fieldSet{values: allValues(minimum, maximum)}, nil
	}
	if strings.ContainsAny(field, "LW#") {
		return fieldSet{}, fmt.Errorf("wildcard %q is not implemented locally", field)
	}
	values := map[int]struct{}{}
	for _, part := range strings.Split(field, ",") {
		step := 1
		rangePart := part
		if slash := strings.Index(part, "/"); slash >= 0 {
			rangePart = part[:slash]
			parsed, err := strconv.Atoi(part[slash+1:])
			if err != nil || parsed <= 0 {
				return fieldSet{}, fmt.Errorf("step %q is not a positive integer", part[slash+1:])
			}
			step = parsed
		}
		start, end := minimum, maximum
		if rangePart != "*" {
			if dash := strings.Index(rangePart, "-"); dash >= 0 {
				parsedStart, err := cronValue(rangePart[:dash], names, minimum, maximum)
				if err != nil {
					return fieldSet{}, err
				}
				parsedEnd, err := cronValue(rangePart[dash+1:], names, minimum, maximum)
				if err != nil {
					return fieldSet{}, err
				}
				start, end = parsedStart, parsedEnd
			} else {
				parsed, err := cronValue(rangePart, names, minimum, maximum)
				if err != nil {
					return fieldSet{}, err
				}
				start = parsed
				end = parsed
				if step > 1 {
					end = maximum
				}
			}
		}
		if start > end {
			return fieldSet{}, fmt.Errorf("range %q runs backwards", rangePart)
		}
		for value := start; value <= end; value += step {
			values[value] = struct{}{}
		}
	}
	return fieldSet{values: values}, nil
}

func cronValue(raw string, names map[string]int, minimum, maximum int) (int, error) {
	trimmed := strings.TrimSpace(raw)
	if named, ok := names[strings.ToUpper(trimmed)]; ok {
		return named, nil
	}
	value, err := strconv.Atoi(trimmed)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("value %q is outside %d..%d", trimmed, minimum, maximum)
	}
	return value, nil
}

func allValues(minimum, maximum int) map[int]struct{} {
	values := make(map[int]struct{}, maximum-minimum+1)
	for value := minimum; value <= maximum; value++ {
		values[value] = struct{}{}
	}
	return values
}

// next returns the first minute after now that matches the expression. The
// search is bounded at five years, which covers every legal year field and
// keeps a never-matching expression from looping forever.
func (c *cronSpec) next(now time.Time) (time.Time, error) {
	candidate := now.UTC().Truncate(time.Minute).Add(time.Minute)
	limit := candidate.AddDate(5, 0, 0)
	for candidate.Before(limit) {
		if c.matches(candidate) {
			return candidate, nil
		}
		candidate = candidate.Add(time.Minute)
	}
	return time.Time{}, fmt.Errorf("cron expression does not fire in the next five years")
}

func (c *cronSpec) matches(instant time.Time) bool {
	if !c.minute.contains(instant.Minute()) ||
		!c.hour.contains(instant.Hour()) ||
		!c.month.contains(int(instant.Month())) ||
		!c.year.contains(instant.Year()) {
		return false
	}
	dayOfMonth := c.dayOfMonth.contains(instant.Day())
	dayOfWeek := c.dayOfWeek.contains(int(instant.Weekday()) + 1)
	switch {
	case c.dayOfMonthAny && c.dayOfWeekAny:
		return true
	case c.dayOfMonthAny:
		return dayOfWeek
	case c.dayOfWeekAny:
		return dayOfMonth
	default:
		return dayOfMonth && dayOfWeek
	}
}
