package oauth

import (
	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func jsonBytesHandler(marshal func() ([]byte, error)) apptheory.Handler {
	return func(*apptheory.Context) (*apptheory.Response, error) {
		b, err := marshal()
		if err != nil {
			return &apptheory.Response{
				Status: 500,
				Headers: map[string][]string{
					"content-type": {"application/json; charset=utf-8"},
				},
				Body: []byte(`{"error":"internal server error"}`),
			}, nil
		}

		return &apptheory.Response{
			Status: 200,
			Headers: map[string][]string{
				"content-type": {"application/json; charset=utf-8"},
			},
			Body: b,
		}, nil
	}
}
