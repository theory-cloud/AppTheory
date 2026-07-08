package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"
)

type response struct {
	Language string `json:"language"`
	Runtime  string `json:"runtime"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	Now      string `json:"now"`
}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(response{
			Language: "go",
			Runtime:  "apptheory-microvm-workload",
			Method:   r.Method,
			Path:     r.URL.Path,
			Now:      time.Now().UTC().Format(time.RFC3339),
		})
	})
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("AppTheory Go MicroVM workload listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
