package apptheory

import (
	"bytes"
	"context"
	"encoding"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const (
	bindErrorMessageEmptyBody      = "request body is empty"
	bindErrorMessageInvalidBinding = "invalid request binding"
	bindErrorMessageValidation     = "validation failed"
	bindErrorMessageStructRequired = "request binding requires a struct target"
	bindSourceQuery                = "query"
	bindSourcePath                 = "path"
	bindSourceHeader               = "header"
)

// BindConfig controls how typed request binding populates a request model.
type BindConfig[Req any] struct {
	Body          bool
	Query         bool
	Path          bool
	Headers       bool
	StrictJSON    bool
	SuccessStatus int
	Validate      func(*Context, Req) error
}

// BindHandler adapts a typed request binder and handler into an AppTheory Handler.
func BindHandler[Req, Resp any](config BindConfig[Req], handler func(*Context, Req) (Resp, error)) Handler {
	return func(ctx *Context) (*Response, error) {
		req, err := BindRequest(ctx, config)
		if err != nil {
			return nil, err
		}

		resp, err := handler(ctx, req)
		if err != nil {
			return nil, err
		}

		status := config.SuccessStatus
		if status == 0 {
			status = 200
		}
		return JSON(status, resp)
	}
}

// BindHandlerContext adapts a typed binder/handler that uses context.Context.
func BindHandlerContext[Req, Resp any](config BindConfig[Req], handler func(context.Context, Req) (Resp, error)) Handler {
	return BindHandler(config, func(ctx *Context, req Req) (Resp, error) {
		return handler(ctx.Context(), req)
	})
}

// BindRequest populates Req from the configured request sources.
func BindRequest[Req any](ctx *Context, config BindConfig[Req]) (Req, error) {
	var req Req

	if config.Body {
		if err := bindBody(&req, ctx, config.StrictJSON); err != nil {
			return req, err
		}
	}

	if config.Path || config.Query || config.Headers {
		if err := bindTaggedRequestFields(&req, ctx, config); err != nil {
			return req, err
		}
	}

	if config.Validate != nil {
		if err := config.Validate(ctx, req); err != nil {
			return req, normalizeValidationError(err)
		}
	}

	return req, nil
}

func bindBody(target any, ctx *Context, strict bool) error {
	if ctx == nil || len(ctx.Request.Body) == 0 {
		return bindBadRequest(bindErrorMessageEmptyBody, nil)
	}

	if strict {
		decoder := json.NewDecoder(bytes.NewReader(ctx.Request.Body))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(target); err != nil {
			return bindBadRequest(errorMessageInvalidJSON, err)
		}
		if decoder.More() {
			return bindBadRequest(errorMessageInvalidJSON, fmt.Errorf("multiple json values"))
		}
		return nil
	}

	if err := json.Unmarshal(ctx.Request.Body, target); err != nil {
		return bindBadRequest(errorMessageInvalidJSON, err)
	}
	return nil
}

func bindTaggedRequestFields[Req any](target *Req, ctx *Context, config BindConfig[Req]) error {
	if target == nil {
		return bindBadRequest(bindErrorMessageStructRequired, nil)
	}

	root := prepareBindTarget(reflect.ValueOf(target))
	if !root.IsValid() || root.Kind() != reflect.Struct {
		return bindBadRequest(bindErrorMessageStructRequired, nil)
	}

	return bindStructFields(root, ctx, config.bindSources())
}

func prepareBindTarget(v reflect.Value) reflect.Value {
	if !v.IsValid() {
		return reflect.Value{}
	}

	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		v = v.Elem()
	}

	for v.IsValid() && v.Kind() == reflect.Pointer {
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		v = v.Elem()
	}

	return v
}

type bindSourceResolver func(reflect.StructField, *Context) ([]string, bindTag, bool)

func bindStructFields(target reflect.Value, ctx *Context, sources []bindSourceResolver) error {
	targetType := target.Type()
	for i := 0; i < target.NumField(); i++ {
		fieldType := targetType.Field(i)
		fieldValue := target.Field(i)

		if fieldType.PkgPath != "" && !fieldType.Anonymous {
			continue
		}

		if fieldType.Anonymous {
			embedded := prepareFieldValue(fieldValue)
			if embedded.IsValid() && embedded.Kind() == reflect.Struct {
				if err := bindStructFields(embedded, ctx, sources); err != nil {
					return err
				}
				continue
			}
		}

		if !fieldValue.CanSet() {
			continue
		}

		if values, tag, ok := resolveBindValues(fieldType, ctx, sources); ok {
			if err := setBoundField(fieldValue, values); err != nil {
				return bindSourceError(tag.source, tag.name, fieldType.Name, err)
			}
		}
	}

	return nil
}

type bindTag struct {
	name   string
	source string
}

func resolveBindValues(field reflect.StructField, ctx *Context, sources []bindSourceResolver) ([]string, bindTag, bool) {
	for _, source := range sources {
		if values, tag, ok := source(field, ctx); ok {
			return values, tag, true
		}
	}
	return nil, bindTag{}, false
}

func prepareFieldValue(v reflect.Value) reflect.Value {
	if !v.IsValid() {
		return reflect.Value{}
	}
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			v.Set(reflect.New(v.Type().Elem()))
		}
		return v.Elem()
	}
	return v
}

func setBoundField(field reflect.Value, values []string) error {
	if len(values) == 0 {
		return nil
	}

	if field.Kind() == reflect.Pointer {
		if field.IsNil() {
			field.Set(reflect.New(field.Type().Elem()))
		}
		return setBoundField(field.Elem(), values)
	}

	if field.Kind() == reflect.Slice {
		slice := reflect.MakeSlice(field.Type(), 0, len(values))
		for _, raw := range values {
			elem := reflect.New(field.Type().Elem()).Elem()
			if err := parseBoundValue(elem, raw); err != nil {
				return err
			}
			slice = reflect.Append(slice, elem)
		}
		field.Set(slice)
		return nil
	}

	return parseBoundValue(field, values[0])
}

func parseBoundValue(field reflect.Value, raw string) error {
	if !field.CanSet() {
		return fmt.Errorf("field is not settable")
	}

	if unmarshaler, ok := field.Addr().Interface().(encoding.TextUnmarshaler); ok {
		return unmarshaler.UnmarshalText([]byte(raw))
	}

	switch field.Kind() {
	case reflect.String:
		field.SetString(raw)
		return nil
	case reflect.Bool:
		v, err := strconv.ParseBool(raw)
		if err != nil {
			return err
		}
		field.SetBool(v)
		return nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if field.Type() == reflect.TypeOf(time.Duration(0)) {
			v, err := time.ParseDuration(raw)
			if err != nil {
				return err
			}
			field.SetInt(int64(v))
			return nil
		}
		v, err := strconv.ParseInt(raw, 10, field.Type().Bits())
		if err != nil {
			return err
		}
		field.SetInt(v)
		return nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v, err := strconv.ParseUint(raw, 10, field.Type().Bits())
		if err != nil {
			return err
		}
		field.SetUint(v)
		return nil
	case reflect.Float32, reflect.Float64:
		v, err := strconv.ParseFloat(raw, field.Type().Bits())
		if err != nil {
			return err
		}
		field.SetFloat(v)
		return nil
	default:
		return fmt.Errorf("unsupported field type %s", field.Type())
	}
}

func bindBadRequest(message string, cause error) *AppTheoryError {
	err := NewAppTheoryError(errorCodeBadRequest, strings.TrimSpace(message))
	if err.Message == "" {
		err.Message = bindErrorMessageInvalidBinding
	}
	err.WithStatusCode(400)
	if cause != nil {
		err.WithCause(cause)
	}
	return err
}

func bindSourceError(source, name, field string, cause error) *AppTheoryError {
	message := fmt.Sprintf("invalid %s binding: %s", source, name)
	if strings.TrimSpace(field) != "" {
		message = fmt.Sprintf("invalid %s binding for %s", source, field)
	}
	return bindBadRequest(message, cause).WithDetails(map[string]any{
		"source": source,
		"name":   name,
		"field":  field,
	})
}

func normalizeValidationError(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := AsAppTheoryError(err); ok {
		return err
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return AppTheoryErrorFromAppError(appErr).WithStatusCode(statusForErrorCode(appErr.Code))
	}
	return NewAppTheoryError(errorCodeValidationFailed, bindErrorMessageValidation).
		WithStatusCode(400).
		WithCause(err)
}

func bindTagValue(field reflect.StructField, key string) string {
	value := strings.TrimSpace(field.Tag.Get(key))
	if value == "" || value == "-" {
		return ""
	}
	if idx := strings.IndexByte(value, ','); idx >= 0 {
		value = value[:idx]
	}
	return strings.TrimSpace(value)
}

func (c BindConfig[Req]) bindSources() []bindSourceResolver {
	sources := make([]bindSourceResolver, 0, 3)

	if c.Path {
		sources = append(sources, func(field reflect.StructField, ctx *Context) ([]string, bindTag, bool) {
			name := bindTagValue(field, "path")
			if name == "" || ctx == nil {
				return nil, bindTag{}, false
			}
			value, ok := ctx.Params[name]
			if !ok {
				return nil, bindTag{}, false
			}
			return []string{value}, bindTag{name: name, source: bindSourcePath}, true
		})
	}

	if c.Query {
		sources = append(sources, func(field reflect.StructField, ctx *Context) ([]string, bindTag, bool) {
			name := bindTagValue(field, "query")
			if name == "" || ctx == nil {
				return nil, bindTag{}, false
			}
			values, ok := ctx.Request.Query[name]
			if !ok || len(values) == 0 {
				return nil, bindTag{}, false
			}
			return append([]string(nil), values...), bindTag{name: name, source: bindSourceQuery}, true
		})
	}

	if c.Headers {
		sources = append(sources, func(field reflect.StructField, ctx *Context) ([]string, bindTag, bool) {
			name := bindTagValue(field, "header")
			if name == "" || ctx == nil {
				return nil, bindTag{}, false
			}
			values, ok := ctx.Request.Headers[strings.ToLower(name)]
			if !ok || len(values) == 0 {
				return nil, bindTag{}, false
			}
			return append([]string(nil), values...), bindTag{name: name, source: bindSourceHeader}, true
		})
	}

	return sources
}
