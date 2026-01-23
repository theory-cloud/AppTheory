package naming

import "testing"

func TestNormalizeStage(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"prod", "live"},
		{"production", "live"},
		{"live", "live"},
		{"dev", "dev"},
		{"development", "dev"},
		{"stg", "stage"},
		{"staging", "stage"},
		{"stage", "stage"},
		{"test", "test"},
		{"testing", "test"},
		{"Local", "local"},
		{"My Env!", "my-env"},
	}
	for _, tt := range tests {
		if got := NormalizeStage(tt.in); got != tt.want {
			t.Fatalf("NormalizeStage(%q)=%q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestBaseName(t *testing.T) {
	if got := BaseName("MyApp", "prod", ""); got != "myapp-live" {
		t.Fatalf("BaseName app-stage: %q", got)
	}
	if got := BaseName("MyApp", "prod", "Acme"); got != "myapp-acme-live" {
		t.Fatalf("BaseName app-tenant-stage: %q", got)
	}
}

func TestResourceName(t *testing.T) {
	if got := ResourceName("MyApp", "Table", "stg", ""); got != "myapp-table-stage" {
		t.Fatalf("ResourceName app-resource-stage: %q", got)
	}
	if got := ResourceName("MyApp", "Table", "stg", "Acme"); got != "myapp-acme-table-stage" {
		t.Fatalf("ResourceName app-tenant-resource-stage: %q", got)
	}
}
